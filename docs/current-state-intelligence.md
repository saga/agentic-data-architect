# Current-State Intelligence

V1.2 先把“现有系统到底是什么”整理成结构化 current state，再进入 target architecture。

## 结果

~~~text
Asset
  + Job / Job Run
  + Dataset / Column
  + Static / Runtime Lineage
  + Profiling
  + Discovery Coverage
  + Findings
  + Source-of-Truth Candidates
  + Semantic Candidates
  + Semantic Context
~~~

## Semantic Context

Semantic Context 是 provider-neutral 的输入层，不是某个数据库产品的别名。

~~~text
                 Semantic Context
                       │
       ┌───────────────┼────────────────┐
       │               │                │
Snowflake Semantic   Data Product   Other Catalog /
View                  metadata      semantic system
       │               │                │
       └───────────────┼────────────────┘
                       ↓
                Canonical Semantic Asset
                       ↓
             Current-State Intelligence
~~~

核心模型只认识 SemanticAsset。Snowflake Semantic View、Data Product、Catalog、dbt、BI 等来源都转换成同一个结构。

## Canonical Estate

Estate 现在已经支持 system/application、data store、dataset、column、job、job run、file、API、dashboard 和 report 等类型；当前 SQL Discovery 会把 SQL 文件建成静态 Job 节点，并保留文件到 Job、Job 到数据集的关系。

## Coverage

至少记录 files scanned、SQL files、parsed statements、parse failures、datasets、dataset lineage coverage、column lineage、semantic assets 和 profiled datasets。

Coverage 是确定性事实，不是模型自己给出的置信度。

## Source-of-Truth Candidates

系统可以根据名称、上下游结构、metadata、semantic context 和 evidence 给出候选。

candidate != confirmed source of truth。业务权威仍由用户确认。

## Semantic Candidates

从 physical schema 和已有 semantic assets 形成 business concept、entity、identifier、metric、temporal dimension 等候选。

已有 Snowflake Semantic View、Data Product 或 Catalog 定义应优先作为上下文，而不是重新猜一遍。

## Retrieval

V1.2 不引入 vector database，先使用 SQLite FTS5、名称匹配、graph traversal、semantic assets、source-of-truth candidates 和 findings。
