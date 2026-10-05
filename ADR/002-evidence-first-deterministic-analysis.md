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
## Appendix A：形成决定时的分析记录（仅供参考）

项目早期讨论的核心问题是：Agent 究竟应该自己“分析数据”，还是应该让确定性代码先把事实算出来，再让 Agent 解释。

当前实现选择了后者。原因不是不信任 Agent，而是 Data Architect 工作中的很多事实本身有可计算的来源：

```text
source file / database
        ↓
parser / adapter / profiler
        ↓
deterministic result
        ↓
Evidence
        ↓
Agent reasoning
        ↓
Claim / Finding / Report
```

具体讨论过几个容易混淆的边界：

1. Coverage 不等于 confidence。parsed statements、connected datasets、profiled datasets 等是系统已经完成了什么的事实，不应该转换成模型概率。
2. Candidate 不等于 truth。Source-of-Truth candidate 是确定性规则筛出来的调查候选，最终业务权威仍需要业务负责人确认。
3. Structural graph 不等于 business fact。Graphify 可以告诉 Agent 代码结构上存在一条关系，但这不自动证明业务语义。
4. LLM 可以提出假设。假设、解释、架构 trade-off 和下一步调查不需要都由 deterministic rule 产生，但事实性结论必须能回到证据。

这也是为什么 Evidence 被设计成跨模块接口，而不是只作为 UI 上的引用编号。

本附录记录的是形成过程，不新增强制规则。