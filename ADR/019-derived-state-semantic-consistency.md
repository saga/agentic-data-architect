# ADR-019：Derived State 必须共享同一套确定性语义

- Status: Accepted
- Date: 2026-10-06

## Context

Mission Progress、Journey Facts、Workflow completion 和 Result summary 都需要判断 Target Architecture、Mapping、Validation 等工作成果是否形成，但历史上存在各自实现，导致同一状态可能被一个页面认为 covered、另一个页面认为 incomplete。

## Decision

1. 业务事实语义只定义一次，归属于 deterministic evaluator / signal builder。
2. Mission Progress、Journey Facts、Workflow completion 和 UI summary 必须消费同一 evaluator。
3. covered 必须有明确规则，不能由 UI 自行用数量推断。
4. draft、proposed、ready、passed 等状态保持原语义，不允许消费者隐式升级。
5. 新 Workflow 所需事实必须先扩展 evaluator，再扩展 completion condition。

## Consequences

- 页面和状态机不会对同一成果给出相互矛盾的完成判断。
- Workflow DSL 保持业务规则无关。

## Related ADRs

ADR-001、ADR-011、ADR-014、ADR-018。