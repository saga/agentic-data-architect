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
