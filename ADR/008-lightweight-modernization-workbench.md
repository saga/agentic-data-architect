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
