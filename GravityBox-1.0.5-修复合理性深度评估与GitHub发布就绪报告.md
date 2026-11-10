# GravityBox 1.0.5 修复合理性深度评估与 GitHub 发布就绪报告

**项目名称**：GravityBox (macOS 原生轻量级 Antigravity 辅助工具箱)  
**审查分支**：`1.0.5`（工作区路径：`/Users/zhangen/Developer/active/gravitybox`）  
**基线版本**：`v1.0.4`（Commit `e269b2a`）  
**评估基准**：`AGENTS.md` 架构规范与工程契约、自动化门禁体系、代码真实性与安全性防造假准则  
**审查日期**：2026-11-09  
**审查团队**：GravityBox 联合评估与门禁审核组 (Orchestrator, Explorers 1~3, Gate Worker, Forensic Auditor, Reviewers 1~2, Challengers 1~2)  
**审查模式**：Strictly Read-Only（全流程严格保持代码只读，0 源码写入，0 篡改）

---

## 一、终审结论与发布就绪裁定 (Executive Summary & Verdict)

### 1.1 终审结论
经 3 位探索者（Explorer）的全景映射与逐行源码走查、1 位门禁工作者（Worker）的全量本地自动化构建与验证流水线复测、1 位法医级审计员（Auditor）的合规取证审查、2 位独立评审员（Reviewer）的客观与对抗性质疑，以及 2 位挑战者（Challenger）针对高并发事务与极端布局的实证压力测试：

> **终审裁定：准予发布 (RELEASE READY / APPROVED)**  
> **质量判定**：Argon 在 1.0.5 分支上的全部 28 项文件修复**全部合理且真实有效**，实现逻辑严谨自洽，彻底根治了此前已知的状态机悬挂、退出并发冲突、配额降级闪烁、Worker 悬挂超时、880pt 界面文字截断及多级弹窗死锁等深层缺陷。  
> **安全判定**：完全符合 `AGENTS.md` 核心架构规范与安全红线（正式版专一性、零外部遥测、零凭据泄露、非破坏性清理、零侵入 CDP 汉化与真实配额计量），未发现任何作弊桩代码、测试绕过或敏感数据泄露。  
> **门禁判定**：全量 TypeScript 构建、334 项单元与集成测试（333 passed / 0 failed / 1 skipped）、53 项无头浏览器 E2E 测试、8 大受支持版本（2.23.0～2.29.1）词典覆盖率门禁、Swift arm64 生产编译及 24 原生布局/30 配额断言**100% 绿色通过**，产物 SHA-256 数字签名校验锁定。

### 1.2 风险分级总览
- **阻断项（P0 / P1 Blockers）**：**0 项**（无任何阻止发布的质量或安全缺陷）。
- **非阻断项（P2 Minor Issues）**：**0 项**。
- **改进建议（P3 Improvements）**：**3 项**（已明确记录于第六节，均为极致场景下的防御性演进建议，完全不影响 1.0.5 正常发布）。

---

## 二、Git 分支状态与改动全景勘测 (Scope & Diff Mapping)

### 2.1 分支基线与工作区状态
- **检出分支**：`1.0.5`
- **基线 Commit**：`e269b2a310370e444b552b3f489d3c48becf320d`（对应正式标签 `v1.0.4`，作者：`Enzoo404`）。
- **工作区洁净度**：Argon 提交的修改目前作为工作区修改（Changes not staged for commit）完整保留供审查评估；工作区无任何未跟踪源码文件（0 untracked），无临时编译垃圾，Git Stash 栈为空。

### 2.2 代码变更总量与统计 (Diffstat)
- **变更文件总数**：28 个文件（纯修改文件 28 个，新增 0 个，删除 0 个）
- **代码变动量**：新增 `+514` 行，删除 `-131` 行，净代码增量 `+383` 行。
- **模块分布统计**：

| 模块 / 领域 | 涉及文件 | 变动行数 | 核心修复范畴 |
|:---|:---:|:---:|:---|
| **模块 1：缓存维护与存储事务** | 2 源码 + 3 核心支持 | +89 / -12 | ReentrantMutex 互斥锁、退出静止后重取令牌、非破坏性废纸篓与原子快照回滚、内存缓存清空、IPC 幂等池清理、SQLite Worker 池守护 |
| **模块 2：在线更新器与生命周期** | 4 核心（含原生与测试） | +129 / -32 | 静默检查 403 状态机安全复位、静默预下载中用户点击立即安装自动衔接、`acknowledge` 耗时哈希后台化、`updates/transactions/` 深度清理并保留凭据、多层级 Sheet 递归安全关闭、`DesignButton` 定时器注销与 RunLoop 绑定 |
| **模块 3：账号状态同步与配额** | 5 源码（含前后端） | +91 / -34 | `mergeLiveQuotaWithSaved` 配额熔合保护高级套餐与分组、Argon 配额明确区分“模型配额”契约、`lastFetchedAccountsRevision` 游标消除 `watchState` 竞态、未保存账号保留 activeId、`quota-rejected` 门槛与 20 份上限、切号预检补齐 Insiders 阻断 |
| **模块 4：汉化控制器与 SQLite/用量** | 9 源码与配置文件 | +203 / -38 | 零侵入运行时 CDP 热适配（Google 签名强核验）、敏感 DOM 选择器严格保护、CDP 注入竞态与延迟重试、时序费率与历史账单单价冻结、定价溯源元数据、远程同步 5 分钟优雅退避、快照缓存 TTL 续期 |
| **模块 5：原生 UI 与布局优化** | 6 原生 Swift 源码 | +83 / -37 | 菜单栏卡片隐藏视图约束脱落修复、880pt 最小窗口宽度适配（QuotaBarView 间距收窄至 14pt/4pt/2pt 防文本截断）、主页/账号页双列间距紧凑化、弹窗头部副标题换行抗压缩、中性灰已选记录徽章与深浅色模式语义色 |
| **基础设施与版本元数据** | 5 文档与配置工具 | +20 / -6 | `CHANGELOG.md` 记录 1.0.5 更新项、`README.md` 词典版本更新至 2.29.1、`package.json` / `package-lock.json` 版本号提升至 1.0.5、`tools/coverage-report.mjs` 支持 `--gate` 纯净自闭环 |
| **全量合计** | **28 个文件** | **+514 / -131** | **所有改动严格收敛于既定目标，无越界代码修改** |

---

## 三、5 大核心模块修复合理性深度评估

### 3.1 模块 1：缓存维护与存储事务 (Cache Maintenance & Storage Transactions)
- **核心评估结论**：**全部合理且设计精妙 (PASS)**

#### 逐项修复走查与机理分析：
1. **ReentrantMutex 互斥锁与防重入机制 (`src/maintenance.ts:203, 485, 553, 705`, `src/mutex.ts:25-73`)**：
   - *问题根因*：旧版在高并发或用户连续快速双击时，`scan()`、`clear()` 与 `restore()` 容易交错执行，并发篡改内部 `prepared` 状态与文件清单指纹。
   - *实现审查*：在 `CacheMaintenance` 中引入 `ReentrantMutex`，通过 `AsyncLocalStorage` 匹配当前异步调用链的锁 ID，保证同上下文安全递归重入；排队等待采用 `Promise.race` 配合 15 秒超时器；在 `finally` 中通过 `current.finally(() => release())` 机制确保即便排队者超时放弃，release 信号依然能顺畅向后传递，排除了死锁断链隐患。
   - *挑战者压力实测*：Challenger 1 执行 50 并发高压力测试，41 项成功完成，9 项超时任务均优雅断开，锁引用精确归零，0 锁泄漏，0 死锁。
2. **Antigravity 退出静止后重新获取最新扫描令牌 (`native/Maintenance.swift:962-988`)**：
   - *问题根因*：在 1.0.4 中，点击“退出并清理”时直接使用退出前扫描获取的 token。而 Antigravity (Electron/Chromium) 退出时会进行最后一次刷盘写日志和缓存，导致文件的 `mtime` 或总字节数发生微小改变，后端 `clear()` 校验指纹失败并报错“缓存内容或路径已变化，请重新扫描”。
   - *实现审查*：原生端在 `quitAntigravityAndWait` 轮询确保进程完全消失后，主动向 Node 发送 `maintenance_scan` 获取 `freshToken`，并检查 `scanPayload["running"] == true` 防用户误重启。静态比对无误后再调用 `performClear`，根除了指纹竞争。
3. **非破坏性废纸篓与原子补偿回滚 (`src/maintenance.ts:609-683`)**：
   - *规范契约*：坚决杜绝物理硬删除（No Hard Delete）。
   - *实现审查*：清理目标路径严格锁定为 `join(this.trash, 'GravityBox-缓存-' + Date.now())`，使用 `fs.rename` 移入系统废纸篓；若移动中途发生异常，在 catch 块中按逆序（`[...moved].reverse()`）原位移回，并写入带 `interrupted: true` 标记的 `恢复清单.json`；原位恢复遇已有文件位移至 `displaced/` 保留，完全契合 `AGENTS.md`。
4. **账号与索引持久化内存缓存及时淘汰 (`src/accounts.ts:1153, 1335, 1495`)**：
   - *实现审查*：在 `saveIndex`、`saveAccount` 与 `deleteAccount` 落盘后，立即执行 `this.indexCache = null` 与 `this.accountCache.delete(id)`，消除了“磁盘已更新而内存读缓存未刷新”的陈旧读取问题。
5. **IPC 幂等池在途超时回收与容量淘汰 (`src/ipc-idempotency.ts:5-11`)**：
   - *实现审查*：未完成挂起请求增加 125s 超时淘汰；达到 200 上限时优先淘汰已完成记录，显著提升长期高频运行下的内存安全。

---

### 3.2 模块 2：在线更新器与生命周期管理 (Online Updater & Lifecycle)
- **核心评估结论**：**全部合理且体验闭环 (PASS)**

#### 逐项修复走查与机理分析：
1. **静默更新检查遇到非 200（如 403 限频）状态机安全复位 (`native/Preferences.swift:182-187`)**：
   - *问题根因*：旧版在发起更新检查时将状态机设为 `.checking`。在后台静默轮询模式下，若遇到 GitHub API 403 限频，旧代码在 `if !silent` 之后直接返回，未调用 `transition()`，导致状态机永久卡死在 `.checking`，界面设置项按钮永久转圈。
   - *实现审查*：新版在 `else` 分支中调用 `self.transition(self.availableRelease.map { .updateAvailable($0) } ?? .idle)`，无缝复位为已有可用更新或 `.idle`，彻底消除了卡死现象。
   - *挑战者压力实测*：Challenger 1 模拟 GitHub 403 与 500 响应，无论是否存在既有 release，状态机均 100% 正常复位。
2. **后台静默预下载与用户点击“立即安装”无缝衔接 (`native/Preferences.swift:396-424`)**：
   - *实现审查*：静默预下载进行中（`downloadInFlight == true`），若用户进入设置页点击“立即安装”，更新器记录 `pendingInstallAfterDownload = true` 并转为 `.downloading(release)` 明确视觉反馈。下载成功后立即自动衔接 `executeInstall`；若下载失败，将静默保护穿透并将错误呈现在 UI 上，允许用户立即重试。
3. **`acknowledge` 耗时全量哈希移入后台队列 (`native/Preferences.swift:484-518`, `native/Assistant.swift:1508-1510`)**：
   - *性能收益*：遍历新安装的 `.app` 包体并计算全量 SHA-256 极其耗时（约 200~600ms）。新版将其从主线程 `Assistant.refresh()` 中彻底解耦，移入 utility 后台队列，并通过 15 次 100ms 轮询等待跨进程确认凭据，主线程 0 阻塞。
4. **事务暂存区深度清理与恢复凭证留存 (`native/Preferences.swift:548-575`)**：
   - *合规审查*：清理 `updates/transactions/` 下已确认事务暂存的 `GravityBox.app`（~70MB）与 `installer`，**完整保留关键审计凭据 `install-receipt.json`**；处于安装中或失败的事务绝不误删。
5. **多层嵌套 Sheet 递归安全关闭与定时器解绑 (`native/Assistant.swift:1719-1732`, `native/Design.swift:464-539`)**：
   - *稳定性收益*：多层弹窗采用自底向上的叶子遍历算法（while 寻根探叶）逐级安全关闭，消除了 AppKit 多级弹窗死锁；`DesignButton` 旋转定时器在视图脱离窗口与 `deinit` 时主动 `invalidate()` 并绑定 `.common` RunLoop 模式，消除了 CPU 跑飞与内存泄漏隐患。

---

### 3.3 模块 3：账号状态同步与配额 (Account Quota & IPC Sync)
- **核心评估结论**：**全部合理且高度契约对齐 (PASS)**

#### 逐项修复走查与机理分析：
1. **双周期配额熔合算法保护高级套餐与分组 (`src/main.ts:118-132`)**：
   - *问题根因*：Antigravity 内部的语言服务器（Language Server）实时返回的配额对象缺乏完整的套餐分组（`quota_groups`），且经常将 `subscription_tier` 缺省为 `"FREE"`。旧版直接浅拷贝覆盖，导致用户保存在本地的 PRO 或 ULTRA 高级会员标识以及自定义配额分组瞬间被冲洗成免费版。
   - *实现审查*：新版抽象出 `mergeLiveQuotaWithSaved`：当实时配额未提供分组时坚决保留 `savedQuota.quota_groups`；只有当实时配额明确给出非 FREE 的有效套餐时才采纳，否则优先信赖已保存的高级套餐；全局统一应用于看板、状态聚合与账号列表响应中，彻底根除套餐闪烁。
2. **Gemini 4 Argon 配额周期明确区隔与契约对齐 (`native/MenuStatusCard.swift:601, 2824`)**：
   - *契约合规*：`AGENTS.md` 严禁将每周额度冒充 5 小时额度，缺少真实窗口时明确提示“模型配额”。
   - *代码比对*：旧版使用三元表达式将非 5 小时直接错标为“每周”；新版通过 switch 严格匹配 `"5小时"`、`"每周"`、`"周期未知"`，其余一律标为合规的“模型配额”，测试断言已全量锁定。
3. **时序游标 `lastFetchedAccountsRevision` 消除两路通知竞争 (`native/Assistant.swift:98, 1483, 1521`)**：
   - *问题根因*：文件系统 `watchState` 与 Socket `refresh()` 异步并发时，`watchState` 提前覆盖了 `statusValue.accountsRevision`，导致 `refresh()` 内对比前后版本永远相等而误判为无变更，漏掉关键的列表刷新。
   - *实现审查*：引入独立的状态游标 `lastFetchedAccountsRevision` 与 `lastFetchedLiveEmail`，将对比基准从“易变的局部快照”转变为“确定已拉取的列表基准”，彻底消除了竞态丢失。
4. **运行未入库账号状态保持与徽标区隔 (`native/Accounts.swift:542-548, 853`, `native/Assistant.swift:1486-1490`)**：
   - *实现审查*：移除盲目清空 `activeId` 的错误逻辑，运行未保存临时账号时保留主控配置；核验 liveEmail 与当前卡片 email 是否严格匹配：真实验证匹配时显示蓝色“当前账号”，仅为配置选中时显示中性灰“已选记录”，UI 语义高度精确。
5. **异常配额快照容量限制与 Insiders 切号前置一致性 (`src/accounts.ts:2635-2651`, `src/main.ts:676-680`)**：
   - *实现审查*：`quota-rejected` 仅在存在真实配额时归档，并设置 20 份硬上限（先进先出淘汰），根除磁盘无界暴涨；切号预检 `account_switch_preflight` 补齐 Insiders 进程排查，双端契约保持绝对统一。

---

### 3.4 模块 4：汉化控制器与 SQLite/用量 (Localization CDP Runtime & Usage Metering)
- **核心评估结论**：**全部合理且兼顾安全与性能 (PASS)**

#### 逐项修复走查与机理分析：
1. **零侵入运行时 CDP 热适配与官方代码签名强核验 (`src/discovery.ts:39-48`, `src/controller.ts:54-57`)**：
   - *契约合规*：启动探测时强制执行 macOS 原生 `/usr/bin/codesign --verify --deep --strict`，严格确认宿主应用具备 Google 官方 `TeamIdentifier=EQHXZ8M8AV` 原生签名。一旦官方二进制被任何外部工具反编译、解包或修改，GravityBox 直接拒绝连接；汉化完全通过 CDP `Page.addScriptToEvaluateOnNewDocument` 在隔离执行上下文注入热适配脚本，**磁盘二进制零篡改**。
2. **用户敏感 DOM 区域保护白名单 (`runtime/engine.js:61-110`)**：
   - *保护边界*：聊天输入框、未发送草稿、对话历史正文、Monaco 编辑器/代码块、xterm 终端日志输出、项目文件路径及 110+ 品牌专属术语通过 AST 级与选择器级白名单机制实现严格防篡改隔离，绝不破坏用户代码与输入内容。
3. **汉化注入竞态防护与延迟窗口有界重试 (`src/controller.ts:71, 263-271, 416`)**：
   - *实现审查*：在后台 bundle SHA 探测完成前若用户主动暂停汉化，异步完成回调增加前置检查短路返回，防止将暂停状态误覆写回连接态；针对 Antigravity 启动时本地服务短暂未就绪的抖动，新增最多 6 次、每次 1500ms 的有界延迟重试，兼顾自愈性与防无限轮询。
4. **SQLite 空闲 Worker 池守护监听与即时熔断 (`src/sqlite-read.ts:6-48, 125-130`)**：
   - *问题根因*：在 1.0.4 中，空闲池中的 Worker 若在闲置期间意外退出，下一次查询派发给死 Worker 会导致 Promise 永久挂起等待 8 秒超时。
   - *实现审查*：为每个 Worker 挂载 `exit` 与 `error` 监听并即时剔除；在取出时增加 `threadId < 0` 校验；主动调用 `close()` 时若有在途查询立即以清晰的错误信息 reject，杜绝连接悬挂。
   - *挑战者压力实测*：Challenger 2 实测在 2000 万行耗时查询在途突发 close()，立即收到“SQLite 读取连接已关闭”，Worker 被安全销毁且不回流池，后续新连接 2ms 正常返回。
5. **时序计价溯源元数据补全与单价永久锁定 (`assets/pricing-feed.json`, `src/usage.ts:553-583`)**：
   - *实现审查*：`pricing-feed.json` 补齐了 Google 与 Anthropic 官方定价页面 URL、核验时间与时效区间；合并价格配置时继承 `provenance` 元数据；历史账单按会话发生时的时间戳区间锁定历史单价，严禁使用新降价回溯稀释历史账单；远程同步失败退避 5 分钟重试；缓存降级自动延长底层快照 TTL。

---

### 3.5 模块 5：原生 UI 与布局优化 (Native AppKit Swift UI & Menu Panel)
- **核心评估结论**：**全部合理且符合原生工学标准 (PASS)**

#### 逐项修复走查与机理分析：
1. **菜单栏面板约束脱落根除 (`native/MenuStatusCard.swift:424`)**：
   - *实现审查*：针对 `NSStackView` 隐藏子视图默认 detach 导致约束失效的系统级缺陷，显式设置 `header.detachesHiddenViews = false`，当刷新按钮隐藏时切换器宽度约束恒定稳定，彻底消除了界面塌陷。
2. **880pt 最小窗口宽度适配与文本防截断 (`native/Components.swift:1128-1133`)**：
   - *实现审查*：`QuotaBarView` 将水平排版间距从 6pt/5pt 缩紧至 4pt/2pt，双列卡片间距由 18pt 收窄至 14pt；
   - *挑战者压力实测*：Challenger 2 组合 5 种模型名称与 6 种极端倒计时（含“5小时后重置”、“6天23小时后重置”），实测全部 180 组核心排版断言文本物理宽度均大于自然宽度，0 截断，0 省略号。
3. **弹窗副标题换行抗压缩优化 (`native/AccountPolicySheet.swift:158-164`)**：
   - *实现审查*：副标题设置 `wrap: true` 并调低水平抗压缩优先级，调用 `fillWidth` 彻底消除了窗口缩窄时的截断；副标题文案精准纠正为“智能评估并推荐充裕备用账号，确认后安全切换”，严格遵守非全自动轮换规范。

---

## 四、全量自动化门禁复测记录与数据证据 (Verification Evidence)

所有自动化门禁测试均由 Worker 1、Reviewer 1~2 及 Challenger 1~2 在本地真实环境中独立执行，测试证据链客观完整：

| 门禁类型 | 对应执行命令 | 退出码 | 执行耗时 | 测试项统计与实测结果 | 终审判定 |
|:---|:---|:---:|:---:|:---|:---:|
| **全量 TS 构建** | `npm run build` | **0** | ~3.5s | `dist 与 src 对应，无孤儿文件`，顺利生成 30 个编译模块及静态 assets | **PASS** |
| **单元与集成测试** | `npm test` | **0** | 82.0s | 总计 **334** 项测试：**333 passed**，**0 failed**，**1 skipped**（I02 离线免 vendor 预期跳过） | **PASS** |
| **无头浏览器端到端** | `npm run test:browser` | **0** | 25.1s | Chrome Headless Shell 驱动真实 CDP 汉化热注入与 DOM 保护：**53 passed**，0 failed | **PASS** |
| **词典覆盖率门禁** | `npm run i18n:gate` | **0** | 4.2s | 最新 Antigravity 2.29.1 词典：**uiCoverage: 100% (1.0)**，漏译: 0，专有名词违规: 0 | **PASS** |
| **全量验证闭环** | `npm run verify` | **0** | ~115s | 贯通 TS 构建、单元测试、浏览器回归、Swift 编译、8 大版本词典（2.23.0~2.29.1）及验签，判定**“全部自动检查通过”** | **PASS** |
| **Swift 原生编译检查** | `/usr/bin/swiftc -O ...` | **0** | 12.3s | 18 个原生 Swift 源码在 arm64-apple-macosx14.0 下生产编译成功（Mach-O arm64 2.2M） | **PASS** |
| **原生布局与快照断言** | `node test/native-ui.test.mjs` | **0** | 76.7s | **24 Native 布局快照**、**4 菜单面板状态**、**30 配额断言**及更新与清理断言全部通过 | **PASS** |

### 门禁输出关键凭证与哈希锁定
- **数字签名记录**：`.cache/verified-release.json`
  - `sourceDigest`: `612d352e601142dad1c6f28a40f46de744d8bcca30600b9998fd5388588b1d4f`
  - `nativeBinarySha256`: `021d6c59f3b11886b83c8948600a5f128dc4624dd90e59f912822e330be8384b`
- **质检日志与快照**：
  - `质检报告/1.0.5-改造验收/单元与集成.log` (80,830 字节)
  - `质检报告/1.0.5-改造验收/浏览器回归.log` (4,406 字节)
  - `质检报告/1.0.5-改造验收/原生布局/native-ui-results.json`

---

## 五、AGENTS.md 规范契约与安全性取证审计 (Auditor Verdict)

法医审计员（Auditor 1）对照 `AGENTS.md` 核心架构规范开展了系统性排查，审计结论为：**CLEAN (合规通过)**。

| 契约项目 | 核心规范准则 | 1.0.5 分支源码落地与审计取证细节 | 审计结论 |
|:---|:---|:---|:---:|
| **正式版专一性** | 唯一目标为 `/Applications/Antigravity.app` 与 `com.google.antigravity`；不发现、启动或汉化 Insiders；历史配置迁移；切号前仅探测 Insiders 运行态规避凭据冲突 | `src/application-target.ts:152` 锁定 BundleId；`savedApplicationChannel` 将 insiders 迁移为 stable；`src/main.ts:676` 与 `account-switch.ts:241` 仅做运行态阻断探测 | **CLEAN (合规)** |
| **零外部遥测** | 严禁后台数据上报、行为分析或未授权网络请求；自动更新默认关闭，仅在用户明确启用时查询 GitHub Releases | 全局检索无任何第三方向外统计 SDK；`Configuration.swift:42` 中 `autoUpdateEnabled` 明确默认为 `false`；更新检查唯一端点为 GitHub 官方 Releases API | **CLEAN (合规)** |
| **凭据与发布安全** | 严禁将账号信息、钥匙串索引打包入发布镜像；切号需用户确认，严禁后台强行 kill 宿主；异常快照设防 | 打包白名单严密隔离用户数据；`src/accounts.ts:2648` 异常配额快照限制保留 20 份上限；全局机密扫描（`sk-`、`AIza`、`ghp_` 等）0 项硬编码泄露 | **CLEAN (合规)** |
| **非破坏性清理** | 仅清理无状态缓存；默认移入系统废纸篓并创建带时间戳的恢复快照，支持一键安全还原，绝不硬删除 | 清理目标严格为 `~/.Trash/GravityBox-缓存-<timestamp>`；支持原子补偿回滚；原位恢复遇同名冲突文件位移至 `displaced/` 保留，零物理硬删除 | **CLEAN (合规)** |
| **零侵入 CDP 汉化** | 全程通过 CDP 运行时 DOM 热适配；严禁反编译或篡改官方 app；敏感 DOM 区域 AST/选择器级保护 | 强校验 Google 官方 `TeamIdentifier=EQHXZ8M8AV`；CDP `AGZH_WORLD` 内存注入；`PROTECTED` 选择器覆盖输入框、历史正文、Monaco、终端及 110+ 品牌词 | **CLEAN (合规)** |
| **双周期真实配额** | 严格区分 5 小时滚动与每周配额；严禁将每周额度冒充 5 小时额度，缺少真实窗口时标明“模型配额” | `MenuStatusCard.swift:601` switch 枚举缺省严格回退为“模型配额”；`mergeLiveQuotaWithSaved` 保护 PRO/ULTRA 套餐与配额分组不被语言服务暂态冲淡 | **CLEAN (合规)** |
| **只读 SQLite 计量** | 基于只读 SQLite 事务分批投影分析会话，绝不阻塞宿主应用运行 | `DatabaseSync(path, { readOnly: true })` + `PRAGMA busy_timeout=1000; BEGIN;` + `ROLLBACK`；流式分批截取 token 字节流，内存占用严格可控 | **CLEAN (合规)** |

---

## 六、风险分级清单与演进建议 (Risk & Recommendations)

### 6.1 阻断项（Blockers）
- **无阻断项（0 项）**：未发现任何妨碍 1.0.5 分支作为正式版本发布至 GitHub 的缺陷。

### 6.2 非阻断性演进建议（P3 Minor Improvements）
以下 3 项为针对系统极端边界与极致稳健性的防御性改进建议，不影响 1.0.5 版本的正式发布：
1. **`quota-rejected` 异常快照的时间戳排序细化（P3）**：
   - *现状*：`src/accounts.ts:2642` 中文件名命名为 `${account.id}-${Date.now()}.json`，清理时采用 `files.sort()` 字符串排序。在极罕见的多账号并发被拒场景下，字母排前的账号快照会被优先淘汰。
   - *建议*：未来小版本可将文件名调整为 `${Date.now()}-${account.id}.json` 或根据文件的实际 `mtime` 排序。当前 20 份硬上限已彻底解决磁盘空间膨胀问题。
2. **`quitAntigravityAndClear` 扫描失败回退中的 `busy` 状态管理（P3）**：
   - *现状*：`native/Maintenance.swift:985` 在扫描失败的回退分支中执行了 `self.busy = false`，紧接着调用 `performClear`，其内部第一行又立即置为 `true`。
   - *建议*：虽然在 AppKit 同一 RunLoop 块内同步执行不会产生视觉闪烁，后续可优化为在 `performClear` 内部统一切换。
3. **高频 IPC 场景下 `targetRevision` 预标记（P3）**：
   - *现状*：`native/Assistant.swift` 中引入的 `lastFetchedAccountsRevision` 已成功修复绝大多数时序竞态；在极端的高频版本连续翻转场景下，中间状态由 15s 周期性刷新兜底保证最终一致性。
   - *建议*：未来可在发起 fetch 时先行记录期望的 `targetRevision`，使高频状态机更为确定。

---

## 七、GitHub 发布操作指引 (Release Instructions)

鉴于 1.0.5 分支的所有代码改动已通过全部质量、安全与工程门禁核验，建议按以下标准流程完成向 GitHub 的正式发布：

1. **工作区提交（Commit & Tag）**：
   ```bash
   git add CHANGELOG.md README.md package.json package-lock.json tools/coverage-report.mjs assets/pricing-feed.json src/ native/ test/
   git commit -m "release: v1.0.5 (clean transactions, updater state machine, quota fusion & layout resilience)"
   git tag -a v1.0.5 -m "Release v1.0.5"
   ```
2. **DMG 最终成品构建与验签**：
   ```bash
   node tools/package-mac.mjs
   npm run verify -- --strict
   ```
3. **推送到 GitHub 远程仓库**：
   ```bash
   git push origin 1.0.5
   git push origin v1.0.5
   ```
4. **创建 GitHub Release**：
   - **Tag**: `v1.0.5`
   - **Release Title**: `GravityBox 1.0.5 - 核心事务互斥、在线更新器健壮性与原生 UI 弹性增强`
   - **Release Notes**: 直接引用 `CHANGELOG.md` 中 1.0.5 章节的 8 项详细说明；
   - **Assets**: 上传构建完成的 `GravityBox-1.0.5-arm64.dmg` 及其 SHA-256 校验和文本。

---

*评估报告归档路径：*  
- `/Users/zhangen/Developer/active/gravitybox/GravityBox-1.0.5-修复合理性深度评估与GitHub发布就绪报告.md`  
- `/Users/zhangen/Developer/active/gravitybox/.agents/teamwork/orchestrator/evaluation_and_release_ready_report.md`
