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

Workflow/Journey 只负责编排高层路线和人工确认，不实现通用 BPM/ETL workflow engine。

## Consequences

项目能保持本机、单用户和可恢复的简单架构，同时仍然能逐步生成企业架构工作产物。

代价是复杂 migration orchestration、migration waves、dual run、cutover 等能力暂不属于核心 runtime，需要未来单独设计。
## Appendix A：形成决定时的分析记录（仅供参考）

项目逐步从 Current-State Discovery 扩展到 Modernization Workbench 后，讨论过是否需要引入完整 Workflow、BPM 或 ETL orchestration。

当时确认真正需要的是几个可恢复、可验证的工作产物：

```text
Current-State
   ↓
Target Architecture
   ↓
Source-to-Target Mapping
   ↓
Architecture Decision
   ↓
Gap Analysis
   ↓
Modernization Plan
```

这些对象有状态，但它们不是通用流程引擎的任务实例。

另一个讨论重点是“不确定内容不能提前填满”。例如没有真实 target component、source/target relation 或业务决定时，系统应该留下 draft / unknown，而不是自动生成一套“看起来合理”的架构。

因此项目保持轻量 Workflow/Journey，只负责高层导航和确认；具体的 migration waves、dual run、cutover、reconciliation orchestration 等复杂能力以后分别设计。

本附录记录的是从 Current-State 工具向 Modernization Workbench 演进时的讨论，不新增额外架构约束。