# ADR-006：业务语义采用 provider-neutral 模型

- Status: Accepted
- Date: 2026-10-05

## Context

Legacy data architecture 调查需要业务语义，但企业环境中的语义来源可能来自 Snowflake Semantic View、Data Product、Catalog、dbt、BI 或业务文档。

如果把某一家厂商的 catalog model 直接设为核心模型，会导致核心 Agent 和分析流程与单一平台绑定。

## Decision

核心层只认识通用的 `SemanticAsset`：

- semantic_view
- data_product
- catalog_term
- metric
- verified_query
- dashboard

不同 provider 负责把自己的语义来源映射到这一模型。

Semantic Context 用于补充和解释当前发现结果，但不能替代当前 Investigation 的 Evidence，也不能自动把 candidate 提升为业务真相。

## Consequences

核心 workflow 和分析逻辑保持 provider-neutral。

代价是不同 provider 的高级特性不能直接暴露在核心模型里；需要通过 provider-specific attributes 或 adapter extension 表达。
## Appendix A：形成决定时的分析记录（仅供参考）

业务语义是 Data Architecture 调查中的高价值信息，但现实环境里的来源并不统一。

讨论过的输入包括：

- Snowflake Semantic View；
- Data Product；
- Data Catalog；
- dbt semantic definitions；
- BI metrics / dashboards；
- business documents。

如果把 Snowflake 或某个 Catalog 产品的对象模型直接提升为核心模型，后续每增加一个 provider 都会把核心 workflow 和 analysis 改一遍。

因此当前采用：

```text
provider
   ↓
adapter / provider-specific extraction
   ↓
SemanticAsset
   ↓
generic Semantic Context
   ↓
Agent reasoning
```

另一个重要边界是 semantic context 不等于 current Investigation fact。它可以补充业务语义，但仍然需要与当前 Investigation 的 Evidence 和实际发现区分。

本附录仅保留形成过程。