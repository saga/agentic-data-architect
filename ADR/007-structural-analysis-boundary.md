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
