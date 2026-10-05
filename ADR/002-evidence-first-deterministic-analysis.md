# ADR-002：事实计算与 Agent 推理分离，Evidence 作为结果依据

- Status: Accepted
- Date: 2026-10-05

## Context

Data Architect 调查既需要确定性的结构分析，也需要 Agent 处理模糊问题、业务含义和架构取舍。

如果让 Agent 自己计算 lineage、数据质量、coverage 或 source-of-truth，就无法稳定判断一个结论到底来自实际输入还是模型推测。

## Decision

确定性的事实由代码和工具计算；Agent 负责调查顺序、解释、假设和架构推理。

关键发现、Finding、Claim 和最终报告中的事实结论必须能够回溯到 Evidence。没有足够 Evidence 时，系统只能把内容表示为 unknown、candidate 或需要确认的事项，不得提升为 confirmed business truth。

Coverage 是确定性事实，不表示 LLM confidence。

Source-of-Truth candidate 只是调查优先级候选，不是已确认的业务权威。

## Consequences

- 结果可审计、可复核；
- Agent 可以自由推理，但不能凭空制造事实；
- Evidence provenance 成为跨模块的重要接口；
- 新能力必须优先考虑如何产生和保存 Evidence，而不是只增加 prompt。

代价是实现会比单纯让 LLM 输出结论更复杂，需要维护 Evidence ID、source hash、discovery run 和结果校验。
