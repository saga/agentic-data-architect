# Architecture Decision Records

这里记录项目中已经明确、会持续影响架构和实现方式的重要决定。

ADR 是当前设计的正式依据。代码、Skill、Workflow、UI 和文档发生架构性变化时，应先检查相关 ADR；如果新的设计推翻或改变现有决定，应新增或更新对应 ADR，而不是只修改实现。

## 当前 ADR

| ADR | 决定 | 状态 |
|---|---|---|
| [ADR-001](./001-data-estate-as-canonical-graph.md) | DataEstate 是唯一 canonical graph；重复图查询统一到轻量 query helpers，不建立第二套 Catalog 模型 | Accepted |
| [ADR-002](./002-evidence-first-deterministic-analysis.md) | 确定性事实由代码/工具计算，Agent 负责推理；当前 Investigation 的事实结论必须可追溯到 Evidence | Accepted |
| [ADR-003](./003-personal-local-agent-runtime.md) | 默认运行模型是个人本机 Agent；runtime 通过统一边界支持 Copilot SDK / CodeBuddy SDK / OpenCode Run，不把 provider execution 变成 domain state | Accepted |
| [ADR-004](./004-local-data-storage-boundaries.md) | SQLite、DuckDB、Parquet、Filesystem 各自承担明确职责 | Superseded |
| [ADR-005](./005-workflow-and-skill-separation.md) | Workflow、Skill、Tool、Agent、Human 分工明确；Workflow 保存/transition 由服务端验证，DSL 保持最小 | Accepted |
| [ADR-006](./006-provider-neutral-semantic-context.md) | Semantic Context 采用 provider-neutral 核心模型 | Accepted |
| [ADR-007](./007-structural-analysis-boundary.md) | Graphify structural-analysis 历史决定 | Superseded |
| [ADR-008](./008-lightweight-modernization-workbench.md) | Modernization work products 保持轻量；artifact validation、semantic review 和 human approval 分层 | Accepted |
| [ADR-009](./009-app-shell-and-ui-state-separation.md) | 前端 App 只负责装配；Journey/Workflow runtime state 由服务端拥有 | Accepted |
| [ADR-010](./010-independent-artifact-review.md) | AI 工作成果增加独立语义质量审核；Reviewer 不替代 Evidence Gate 或人工批准 | Accepted |
| [ADR-011](./011-mission-contract-as-investigation-boundary.md) | Mission Contract 作为 Investigation 的最高优先级任务边界；正式调查必须经过用户确认，并与 Scope Validation 分离 | Accepted |
| [ADR-012](./012-soul-and-relationship-memory-isolation.md) | Soul / Relationship Memory 只影响最终 Persona Rendering，不进入 Task Agent reasoning | Accepted |
| [ADR-013](./013-global-task-configuration-layering.md) | Global Config 与 Task Override 分层；Task 只保存 sparse override，不能修改 Global 或 runtime-owned capability | Accepted |
| [ADR-014](./014-probabilistic-agent-deterministic-gates.md) | Agent 提议、Smart Function advisory、Deterministic Gate 控制关键状态转换、Human 承担最终业务批准 | Accepted |
| [ADR-015](./015-scope-validation-precondition.md) | Scope Validation 是正式调查和依赖范围完整性的最终交付的前置条件 | Accepted |
| [ADR-016](./016-api-contract-ownership-and-view-models.md) | 跨 server/web 的数据对象只有一个 authoritative API Contract，UI 使用明确的 View/Projection | Accepted |
| [ADR-017](./017-investigation-artifact-lifecycle-and-revision.md) | Artifact 绑定 Mission/Scope/Source revision，读取与生成分离 | Accepted |
| [ADR-018](./018-canonical-workflow-runtime-contract.md) | WorkflowSnapshot 是唯一 canonical Workflow runtime resource，/journey 仅兼容 | Accepted |
| [ADR-019](./019-derived-state-semantic-consistency.md) | Mission、Workflow、Result 的 derived state 使用统一 deterministic semantics | Accepted |
| [ADR-020](./020-runtime-events-error-and-persistence-contracts.md) | SSE、HTTP error、Trajectory 和 durable data 使用统一 runtime contract | Accepted |
| [ADR-021](./021-stage-checkpoint-semantics.md) | Stage Checkpoint 表示真实执行阶段，不等同 Deliverable completion | Accepted |
| [ADR-022](./022-current-data-architecture-and-assessment-separation.md) | Current Data Architecture 负责看清现状；Data Architecture Assessment 负责评价现状并给出改进顺序 | Accepted |
| [ADR-023](./023-investigation-report-and-analysis-artifacts.md) | 每次完整 Investigation 都要有用户可读报告，并保留可继续使用的中间分析产物 | Accepted |
| [ADR-024](./024-skill-input-output-gate-contract.md) | 每个 Skill 都必须声明输入、输出、验证、Gate 和期望结果，并接受基础结构检查 | Accepted |
| [ADR-025](./025-global-task-config-and-media-cache-boundaries.md) | Global / Task 配置与缓存分层；远程媒体由 yt-dlp 解析，Remote first、Global Cache fallback | Accepted |


## 如何使用 ADR

实现新功能前先看相关 ADR。

架构变更需要明确回答三个问题：

1. 当前 ADR 是否已经覆盖这个决定？
2. 新方案是否违反现有 ADR？
3. 如果违反，是应该修改原 ADR，还是形成一个新的 ADR？

已经不再适用的决定不要删除。把原 ADR 标记为 Superseded，并在其中指向替代它的新 ADR。

实现、README、普通设计文档和代码注释可以补充 ADR，但不能悄悄改变 ADR 已经明确的架构边界。

## ADR 附录说明

每个 ADR 可以包含“形成决定时的分析记录”附录，用来保存做出决定时的代码分析、方案比较、被否决的方向、外部项目参考和后续讨论。

这些附录只是历史参考，**不是规范文本**。真正具有架构约束力的是 ADR 正文中的 Context、Decision、Consequences 和 Rejected alternatives。

因此，阅读 ADR 时先看正文；需要理解“为什么会做出这个决定”或追溯设计演进时，再阅读附录。

| [ADR-026](./026-canonical-derived-state-and-result-boundaries.md) | Canonical Derived State 统一 Mission、Workflow、Gate 的完成语义，并分离 Assessment / Modernization Artifact 与 Workflow runtime | Accepted |
| [ADR-027](./027-investigation-state-persistence-boundary.md) | 明确 context.json、SQLite、DuckDB 和文件产物各自的 canonical persistence boundary | Accepted |
| [ADR-028](./028-agent-runtime-selection-and-fallback.md) | 三种 Agent Runtime 选择与 quota fallback：Copilot SDK → CodeBuddy SDK → OpenCode Run | Accepted |
| [ADR-029](./029-conversation-turn-failure-durability.md) | Agent 失败也是已发生的 Conversation Turn；秘书消息和已流出的 assistant 内容必须在失败时持久化，SSE 只是实时显示通道 | Accepted |
| [ADR-030](./030-sse-restart-and-turn-recovery.md) | SSE 只负责实时显示；turn draft、Server shutdown、restart recovery 和浏览器 reconnect 必须保护 Conversation Turn 可恢复性 | Accepted |
| [ADR-031](./031-codebuddy-investigation-sandbox.md) | CodeBuddy Investigation 只使用只读 built-in tools；禁止宿主仓库写入和 shell 路径逃逸 | Accepted |
| [ADR-032](./032-agent-runtime-adapter-isolation-and-workflow-completion.md) | Runtime adapter 互不直接依赖；共享输入/Graphify 能力下沉；无 completeWhen 的 Agent 节点必须先通过 Stage Gate | Accepted |
- [ADR-033：轻量级 Code Structure Index 作为 Graphify 的可替换实现](033-lightweight-code-structure-index.md) — 不安装 Graphify 时，用少量确定性代码结构索引提供 find/callers/callees/trace，并通过 Evidence 边界接入 Investigation。

| [ADR-034](./034-remove-graphify-use-code-structure-index.md) | 完全移除 Graphify，Code Structure Index 成为唯一结构分析能力 | Accepted |
| [ADR-035](./035-polyglot-structure-analysis-provider-boundary.md) | 多语言采用 Provider + Artifact Extractor；不把所有工件强行 Tree-sitter 化 | Accepted |
