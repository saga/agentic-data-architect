# ADR-007：Graphify 作为结构分析能力，而不是事实来源

- Status: Accepted
- Date: 2026-10-05

## Context

代码仓库规模较大时，仅靠逐文件阅读很慢。项目需要一个确定性的结构导航能力帮助 Agent 找模块、调用关系、SQL 和文件之间的候选连接。

Graphify 很适合做 structural graph，但结构关系本身不一定等于业务事实。

## Decision

Graphify 是平台级 structural-analysis capability。

它负责：

- 建立和查询代码/SQL structural graph；
- 帮助 Agent 缩小调查范围；
- 给出结构关系候选。

它不直接产生本项目的 Claim Evidence，也不能单独把 structural observation 提升为 supported/verified business fact。

关键事实仍然需要回到本项目自己的 source provenance、DataEstate、lineage、profiling、targeted query 或 Semantic Context。

Graphify 的 runtime version、graph hash 等运行信息进入 audit。

## Consequences

Agent 可以高效导航大型 repository，同时不会因为 structural graph 存在就绕过 Evidence-first 规则。

代价是同一条关系可能存在“结构候选”和“可验证事实”两个阶段，Agent/Skill 必须理解这两个边界。
## Appendix A：形成决定时的分析记录（仅供参考）

项目研究大型 legacy repository 时，一个实际问题是：逐文件阅读效率太低。

因此引入 Graphify 作为 structural-analysis capability，主要解决“先找到应该读什么”的问题，例如：

- 模块之间怎么连接；
- 哪个文件实现了某个调用；
- SQL 和代码有哪些结构关系；
- 哪些节点值得优先深入。

讨论过程中明确区分了两个阶段：

```text
Structural observation
        ↓
调查候选
        ↓
人工 / Agent 深入检查
        ↓
本项目 Evidence
        ↓
可用于 Claim / Finding 的事实
```

所以 Graphify 不应该成为第二个事实系统。

这也是为什么 runtime version、command、graph hash 需要进入 audit，而 Graphify graph 本身不能直接绕过本项目的 Evidence validation。

本附录只记录为什么划这个边界。