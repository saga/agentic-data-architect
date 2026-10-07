# ADR-018：Workflow Runtime 的唯一 Canonical State 与兼容接口

- Status: Accepted
- Date: 2026-10-06

## Context

系统中曾同时存在 Journey、Workflow、JourneyState 和 WorkflowSnapshot 多套运行状态表示。相同 execution 信息也可能出现在不同层级。

## Decision

1. WorkflowSnapshot 是 server → web 的唯一 canonical Workflow runtime resource。
2. Snapshot 由 definition、layout、execution、derived state 和 run events 组成。
3. execution 只能存在一个 canonical owner；其它旧字段只能作为兼容 projection，不能独立修改。
4. Web 的 Workflow、Journey、Context Panel 统一消费 WorkflowSnapshot。
5. `/journey` 是现有路由入口，但返回的就是 canonical `WorkflowSnapshot`；它不是第二套 Journey response，也不承担兼容语义。
6. Workflow node、actor、status、route 等核心枚举由 canonical contract 定义。

## Consequences

- Workflow Editor、Context Panel 和 transition 使用同一运行状态。
- 消除 Journey / Workflow response 漂移。

## Related ADRs

ADR-005、ADR-009、ADR-016。