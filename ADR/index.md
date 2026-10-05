# Architecture Decision Records

这里记录项目中已经明确、会持续影响架构和实现方式的重要决定。

ADR 是当前设计的正式依据。代码、Skill、Workflow、UI 和文档发生架构性变化时，应先检查相关 ADR；如果新的设计推翻或改变现有决定，应新增或更新对应 ADR，而不是只修改实现。

## 当前 ADR

| ADR | 决定 | 状态 |
|---|---|---|
| [ADR-001](./001-data-estate-as-canonical-graph.md) | DataEstate 是唯一 canonical graph；重复图查询统一到轻量 query helpers，不建立第二套 Catalog 模型 | Accepted |
| [ADR-002](./002-evidence-first-deterministic-analysis.md) | 确定性事实由代码/工具计算，Agent 负责推理；事实结果必须可追溯到 Evidence | Accepted |
| [ADR-003](./003-personal-local-agent-runtime.md) | 默认运行模型是个人本机 Agent，不按多人共享 Agent Server 设计 | Accepted |
| [ADR-004](./004-local-data-storage-boundaries.md) | SQLite、DuckDB、Parquet、Filesystem 各自承担明确职责 | Accepted |
| [ADR-005](./005-workflow-and-skill-separation.md) | Workflow、Skill、Tool、Agent、Human 分工明确；Workflow DSL 保持最小 | Accepted |
| [ADR-006](./006-provider-neutral-semantic-context.md) | Semantic Context 采用 provider-neutral 核心模型 | Accepted |
| [ADR-007](./007-structural-analysis-boundary.md) | Graphify 用于 structural navigation，不直接作为业务事实来源 | Accepted |
| [ADR-008](./008-lightweight-modernization-workbench.md) | Modernization work products 保持轻量，不引入重量级 Workflow Engine | Accepted |

## 如何使用 ADR

实现新功能前先看相关 ADR。

架构变更需要明确回答三个问题：

1. 当前 ADR 是否已经覆盖这个决定？
2. 新方案是否违反现有 ADR？
3. 如果违反，是应该修改原 ADR，还是形成一个新的 ADR？

已经不再适用的决定不要删除。把原 ADR 标记为 `Superseded`，并在其中指向替代它的新 ADR。

实现、README、普通设计文档和代码注释可以补充 ADR，但不能悄悄改变 ADR 已经明确的架构边界。