# Antigravity 对话常驻状态栏（Conversation Status HUD）架构设计规范 (v2.2)

## 1. 核心目标与 v2.2 全量审计升级要点
针对 Antigravity `2.30.0` 真机实测与全栈深度代码审计，`feature/conversation-status-hud` 分支完成了 v2.2 架构升级：
1. **移除原生悬浮提示与 Top Layer 顶层防遮挡（`popover="manual"`）**：
   - 移除状态栏 3 个胶囊按钮上的原生 HTML `title="..."` 属性（保留无障碍 `aria-label`），消除系统 Tooltip 遮挡。
   - 针对宿主输入框位于 `div.relative.z-10` 层叠上下文内导致外层 `z-index: 20`「滚动到底部」悬浮按钮压盖详情卡片的实机缺陷，3 个 `.hud-popover` 全面升级为 Chromium 原生 **Top Layer (`popover="manual"`)**，彻底突破祖先层叠上下文、`overflow: hidden` 与 `transform` 包含块限制，并采用无横缝双路径 SVG 指示三角与捕获阶段（`capture: true`）点击外部收起机制。
2. **子智能体（Subagent）工作状态全链路感知与指标聚合**：
   - **DOM 层实时探针与子智能体侧栏（`subpane`）独立挂载**：识别 `[data-testid="idle-status-text"]`、`[data-testid="running-subagent-steps-toggle"]`、中英文全角/半角 `Open Subagent:` / `打开子智能体：` 活跃芯片与 `停止子智能体` 按钮；当右侧子智能体对话面板（`[data-media-drop-scope="subpane"]`）展开可见时自动为其挂载独立 HUD 实例。
   - **SQLite 真实列映射与双向归属校验**：对接 Antigravity `2.30.0` 真实的 `steps.render_info` / `steps.step_payload` 列与子会话 `trajectory_metadata_blob` 父会话反向引用，仅对子智能体调度工具提取并校验归属 UUID，彻底阻断普通工具参数（如 `run_command`）中无关会话 UUID 的串号污染，并在状态栏第一分段展示 `· 子智能体运行中` 及呼吸脉冲动画。
3. **全指标 Protobuf 逆向溯源与推理模型（Thinking Model）TTFT / TPS 物理校准**：
   - 从 `vendor/antigravity/2.30.0/main.js` 完整解码 `CortexStepMetadata`、`ModelUsageStats`、`ChatModelMetadata` 与 `ContextWindowMetadata` 官方 Protobuf 描述符。
   - **根除推理模型 `355 tok/s` 与 `8.0s TTFT` 失真**：通过稳态持续流式窗口（$\Delta t_{\text{post}} \ge 0.5\text{s}$）校准思维链生成耗时 $\Delta t_{\text{thinking}}$，并对超过 `64KB` 的超大 `gen_metadata` / `steps` 记录自动切换 `projectProtobuf` 分块流式投影与 24 会话有界 LRU 缓存，守护 `128MB` 堆上限。
4. **macOS 原生设置开关与全生命周期闭环**：
   - 在 GravityBox 原生「设置」页新增「对话状态栏」实时开关（`hudEnabled` + `hud_set` IPC），支持持久化与毫秒级热启停、无损恢复宿主内边距，并打通 `addScriptToEvaluateOnNewDocument` 整页重载挂起与 `session.contextId` 导航重同步闭环。

## 2. 全量指标数据源、Protobuf 字段映射与计算公式审计表

| 模块 | 指标名称 | 底层真实数据源（SQLite 表 / 列 / DOM） | Protobuf 消息与精确字段编号 | 计算公式与物理校准逻辑 |
| :--- | :--- | :--- | :--- | :--- |
| **分段 1 & 卡片 1** | **实时状态呼吸灯** | DOM + `steps.status` | `CortexStepStatus` (`1=PENDING, 2=RUNNING, 8=GENERATING, 9=WAITING`) | 主智能体流式生成或子智能体运行（`isSubagentRunning`）时激活 `#3186FF` 脉冲动画 |
| **分段 1 & 卡片 1** | **对话轮次 (`N 轮`)** | `steps.step_type` | `CortexStepType.USER_INPUT = 14`（回退 `101`） | $\text{turns} = \text{COUNT}(14) > 0 \ ? \ \text{COUNT}(14) : \text{COUNT}(101)$ |
| **分段 1 & 卡片 1** | **执行步数 (`M 步`)** | `steps` 主表 + 关联子会话 `steps` | `CortexStep` 行记录 | $\text{steps} = \text{COUNT}(\text{main.steps}) + \sum \text{COUNT}(\text{child.steps})$ |
| **分段 1 & 卡片 1** | **模型用时** | `steps.metadata` (`step_type = 15`) | `CortexStepMetadata`: `field 1` (`created_at`), `field 7` (`finished_generating_at`), `field 22` (`last_completed_chunk_at`), `field 8` (`completed_at`) | $\sum_{s \in S_{15}} \max(0, t_{\text{gen\_end}, s} - t_{\text{created}, s})$，其中 $t_{\text{gen\_end}} = f_7 \ ?? \ f_{22} \ ?? \ f_8$ |
| **分段 1 & 卡片 1** | **工具调用用时** | `steps.metadata`（工具步 `step_type`） | `CortexStepMetadata`: `field 32` (`started_at`), `field 1` (`created_at`), `field 8` (`completed_at`) | $\sum_{s \in S_{\text{tool}}} \max(0, t_{\text{completed}, s} - t_{\text{start}, s})$，优先取 $f_{32}$ (`started_at`) 剔除排队与审批等待时间 |
| **分段 1 & 卡片 1** | **首 token 平均 (TTFT)** | `gen_metadata.data` / `steps.metadata` | `ChatModelMetadata.field 11` (`time_to_first_token`) / `CortexStepMetadata` `field 1, 6` | 无思维链步取 $f_6 - f_1$；含思维链步剥离思维链耗时 $\text{TTFT}_s = (f_6 - f_1) - \Delta t_{\text{thinking}, s}$ |
| **分段 1 & 卡片 1** | **输出速度 (TPS)** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats.field 3` (`output_tokens`) / `CortexStepMetadata` `field 1, 6, 7` | $\text{TPS} = \frac{\sum \text{output\_tokens}}{\sum (\Delta t_{\text{thinking}, s} + (t_{\text{gen\_end}, s} - t_{\text{viewable}, s}))}$，含 $0.1\text{s}$ 窗口保护与 $500\text{ tok/s}$ 上限 |
| **分段 1 & 卡片 1** | **子智能体状态** | DOM + `steps.render_info` + `trajectory_metadata_blob` | `CortexStepType` `127/132` + `ChatToolCall.field 2` | 双向归属核验子智能体会话并实时显示 `· 子智能体运行中` 及子会话步数 |
| **分段 2 & 卡片 2** | **Token 用量总计** | `steps.metadata` (`step_type = 15`) | `CortexStepMetadata.field 9` (`ModelUsageStats` `field 2, 3, 4, 5`) | $\sum (f_2 + f_5 + f_4 + f_3)$（未缓存输入 + 缓存读取 + 缓存写入 + 输出） |
| **分段 2 & 卡片 2** | **缓存命中率** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats`: `field 5`, `field 2`, `field 4` (`cache_write_tokens`) | $\frac{\sum \text{cache\_read\_tokens}}{\sum \text{input\_tokens} + \sum \text{cache\_read\_tokens} + \sum \text{cache\_write\_tokens}} \times 100\%$ |
| **分段 2 & 卡片 2** | **未缓存输入** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats.field 2` (`input_tokens`) | $\sum \text{input\_tokens}$ |
| **分段 2 & 卡片 2** | **缓存读取** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats.field 5` (`cache_read_tokens`) | $\sum \text{cache\_read\_tokens}$ |
| **分段 2 & 卡片 2** | **缓存写入** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats.field 4` (`cache_write_tokens`) | $\sum \text{cache\_write\_tokens} > 0$ 时动态展示（如 Claude 系列） |
| **分段 2 & 卡片 2** | **输出** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats.field 3` (`output_tokens`) | $\sum \text{output\_tokens}$ |
| **分段 2 & 卡片 2** | **思维链 / 回复** | `steps.metadata` (`step_type = 15`) | `ModelUsageStats`: `field 9` (`thinking_output_tokens`), `field 10` (`response_output_tokens`) | 分别汇总 $\sum f_9$（思维链推理）与 $\sum f_{10}$（正文及工具调用回复），恒满足 $f_9 + f_{10} = f_3$ |
| **分段 3 & 卡片 3** | **当前上下文占比与容量** | 最新 `step_type = 15` + `gen_metadata.data` | `ContextWindowMetadata` (`field 1, 4`) / `CascadePlannerConfig.field 14` / `ModelInfo.field 4` | $\text{usedTokens} = \max(f_2+f_4+f_5, \text{estimated\_tokens\_used})$；$\text{usedRatio} = \min(1, \text{usedTokens} / \text{capacityTokens})$ |
| **分段 3 & 卡片 3** | **缓存复用上下文** | 最新一步 `step_type = 15` | `ModelUsageStats.field 5` (`cache_read_tokens`) | 最新单步 `cache_read_tokens` |
| **分段 3 & 卡片 3** | **本步新增输入** | 最新一步 `step_type = 15` | `ModelUsageStats`: `field 2` (`input_tokens`) + `field 4` (`cache_write_tokens`) | $\text{usedTokens} - \text{cachedContextTokens}$ |
| **分段 3 & 卡片 3** | **本步生成输出** | 最新一步 `step_type = 15` | `ModelUsageStats.field 3` (`output_tokens`) | 最新单步 `output_tokens` |
| **分段 3 & 卡片 3** | **会话历史峰值与压缩次数** | 全表 `steps` | `ModelUsageStats` (`field 2, 4, 5`) + `CortexStepType.CHECKPOINT = 23` | $\max_{s \in S_{15}}(f_2 + f_4 + f_5)$；压缩次数 = $\text{COUNT}(\text{step\_type} = 23)$ |
| **分段 3 & 卡片 3** | **当前模型** | DOM 模型选择器 + `gen_metadata.data` | `ChatModelMetadata.field 19, 21` | 优先响应前端模型切换，同模型时展示底层权威 `model_display_name` |
