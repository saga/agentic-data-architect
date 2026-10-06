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
5. /journey 只作为 compatibility endpoint；新代码不得继续创建第二套 Journey response。
6. Workflow node、actor、status、route 等核心枚举由 canonical contract 定义。

## Consequences

- Workflow Editor、Context Panel 和 transition 使用同一运行状态。
- 消除 Journey / Workflow response 漂移。

## Related ADRs

ADR-005、ADR-009、ADR-016。