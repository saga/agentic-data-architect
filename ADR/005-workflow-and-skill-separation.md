# ADR-005：Workflow 定义路线，Skill 提供能力，DSL 保持最小

- Status: Accepted
- Date: 2026-10-05

## Context

项目既需要固定的 Data Architect 工作路线，又希望 Agent 能自主选择查询、SQL、profiling、GitHub、Confluence 等能力。

如果把所有能力写入 Workflow，Workflow 会变成一个庞大的 execution engine；如果把阶段和完成条件都交给 Skill/Prompt，又无法稳定控制 Investigation 的进度。

## Decision

Workflow 与 Skill 严格分工：

- Workflow：定义当前做什么、顺序、分支和完成条件；
- capability Skill：说明某项能力何时适用以及如何使用；
- Tool：真正执行 SQL、profiling、lineage、search 等操作；
- Agent：决定调查动作、解释证据和选择已有 outcome；
- Human：确认业务定义、范围、例外和重要架构判断。

Workflow DSL 保持最小，只使用 `@flow`、`@task`、`@review`、`@end`，节点只描述必要的业务语义，不把 tools、permissions、route conditions 等执行细节塞入 DSL。

Agent 不能发明不存在的 Workflow branch；服务端负责验证和真正推进状态。

## Consequences

Workflow 可以被 UI 编辑，同时不会把 UI/engine 细节污染 DSL。

代价是部分 Agent 自由度必须通过宿主规则约束，但这种约束正是为了让路线可恢复、可审计和可测试。
