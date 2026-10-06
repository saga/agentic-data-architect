# ADR-002：事实计算与 Agent 推理分离，Evidence 作为结果依据

- Status: Accepted
- Date: 2026-10-05

## Context

Data Architect 调查既需要确定性的结构分析，也需要 Agent 处理模糊问题、业务含义和架构取舍。

如果让 Agent 自己计算 lineage、数据质量、coverage 或 source-of-truth，就无法稳定判断一个结论到底来自实际输入还是模型推测。

同时，项目会逐步积累 Research Knowledge、Semantic Context、structural observations 和 candidate。它们可以帮助未来 Investigation，但不能因为“以前见过”或“结构上可能成立”就自动成为当前 Investigation 的事实。

## Decision

确定性的事实由代码和工具计算；Agent 负责调查顺序、解释、假设和架构推理。

关键发现、Finding、Claim 和最终报告中的事实结论必须能够回溯到当前 Investigation 的 Evidence。没有足够 Evidence 时，系统只能把内容表示为 unknown、candidate 或需要确认的事项，不得提升为 confirmed business truth。

可复用 Knowledge、Semantic Context 和 structural observations 可以作为调查输入和候选线索，但必须在当前 Investigation 中重新关联、验证并形成自己的 Evidence 后，才能支撑当前 Claim / Finding。

Coverage 是确定性事实，不表示 LLM confidence。

Source-of-Truth candidate 只是调查优先级候选，不是已确认的业务权威。

## Consequences

- 结果可审计、可复核；
- Agent 可以自由推理，但不能凭空制造事实；
- Evidence provenance 成为跨模块的重要接口；
- 新能力必须优先考虑如何产生和保存 Evidence，而不是只增加 prompt；
- Knowledge、Semantic Context 和 structural analysis 不会形成第二套 current-state truth。

代价是实现会比单纯让 LLM 输出结论更复杂，需要维护 Evidence ID、source hash、discovery run 和结果校验。

## Related

- ADR-006：Provider-neutral Semantic Context
- ADR-007：Structural Analysis Boundary
- ADR-014：概率 Agent 与确定性 Gate
