# ADR-008：Modernization Workbench 保持轻量，不引入重量级 Workflow Engine

- Status: Accepted
- Date: 2026-10-05

## Context

项目目标不仅是发现旧系统，还要逐步产生 Target Architecture、Source-to-Target Mapping、Architecture Decision、Gap Analysis 和 Modernization Plan。

这些对象需要有状态，但当前项目不是通用企业流程引擎。

## Decision

Modernization work products 作为轻量、可验证的结构化对象保存。

它们依赖：

- Current-State；
- Evidence；
- deterministic Findings；
- 用户确认的业务范围；
- Agent 的架构推理。

不自动填充未经调查的 target component、mapping 或 architecture decision。

Artifact 生命周期保持简单：可以处于 draft / proposed / validated / approved 等明确状态，但“结构有效”“语义审核通过”和“业务批准”不是同一个条件。

Workflow/Journey 只负责编排高层路线和人工确认，不实现通用 BPM/ETL workflow engine。

### Gate 与 Reviewer 的关系

Evidence / deterministic validation 证明 artifact 满足机器可验证的结构和证据要求。

Independent Reviewer 检查语义质量和目标匹配。

两者都不能替代涉及业务权威或不可逆动作的 Human approval。

## Consequences

项目能保持本机、单用户和可恢复的简单架构，同时仍能逐步生成企业架构工作产物。

代价是复杂 migration orchestration、migration waves、dual run、cutover 等能力暂不属于核心 runtime，需要未来单独设计。

## Related

- ADR-010：Independent Artifact Review
- ADR-014：概率 Agent 与确定性 Gate
