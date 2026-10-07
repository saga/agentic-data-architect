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
- Agent：决定调查动作、解释证据和选择已有 outcome；capability Skill 由 Runtime / host 自动发现，当前 Workflow Skill 只暴露用户选择的路线；
- Human：确认业务定义、范围、例外和重要架构判断。

Workflow DSL 保持最小，只使用 @flow、@task、@review、@end，节点只描述必要的业务语义，不把 tools、permissions、route conditions 等执行细节塞入 DSL。

Agent 不能发明不存在的 Workflow branch；服务端负责验证和真正推进状态。

Workflow editor 只是编辑界面。AI 可以提出 Workflow patch，但服务端必须验证其结构和语义约束后才能保存；每次保存产生新的 Workflow version，运行中的 Journey 不被 UI 直接重写。

关键状态转换遵循 ADR-014：Agent 的 completion 判断只是建议，真正的 transition 必须经过对应 Gate。

## Consequences

Workflow 可以被 UI 编辑，同时不会把 UI/engine 细节污染 DSL。

代价是部分 Agent 自由度必须通过宿主规则约束，但这种约束正是为了让路线可恢复、可审计和可测试。

## Related

- ADR-009：App shell 与 UI state separation
- ADR-014：概率 Agent 与确定性 Gate
