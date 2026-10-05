# ADR-004：SQLite、DuckDB、Parquet 和文件系统职责分离

- Status: Accepted
- Date: 2026-10-05

## Context

项目需要同时保存 Investigation 状态、对话、数据集登记、本地分析结果和用户原始文件。

把所有内容塞进一个数据库会让应用状态和 analytical workload 互相影响，也会削弱文件数据的可移植性。

## Decision

职责固定为：

- SQLite：应用状态 system of record，包括对话、Investigation、Dataset Registry 和 analysis run metadata；
- DuckDB：每个 Investigation 独立的本地分析引擎；
- Parquet：大型分析数据和可移植中间结果；
- Filesystem：原始输入和用户可直接打开的报告/产物。

每个 Investigation 使用自己的 `local.duckdb`。

Agent 不直接拿 DuckDB 文件路径；本地数据通过 `local_catalog`、`local_register_dataset`、`local_describe`、`local_sample`、`local_profile`、`local_query` 等受控工具访问。

当前不引入统一 SQL abstraction framework、复杂 Repository/Unit of Work、共享 DuckDB writer、完整 ETL scheduler、vector DB 或 Lakehouse Catalog。

## Consequences

- 应用状态和 analytical data boundary 清晰；
- DuckDB 能保持本地分析能力；
- Parquet 便于大结果继续被其他工具使用；
- Agent 不能绕过 Dataset Registry 和 Evidence provenance。

代价是系统需要维护 Dataset Registry 与本地文件版本之间的关系，并在工具层承担 SQL/path guard。
## Appendix A：形成决定时的分析记录（仅供参考）

本地数据层的讨论围绕一个问题展开：为什么不直接让 DuckDB 成为整个应用的数据库。

当前 Investigation 同时有两类完全不同的数据：

- 应用状态：对话、Investigation、Workflow、analysis run metadata、Dataset Registry；
- analytical data：CSV、JSON、Parquet 和分析结果。

把两类内容合在一起会让“应用状态”和“分析引擎”互相耦合，因此形成：

```text
SQLite
  = application state / metadata

DuckDB
  = analytical engine

Parquet
  = portable analytical data

Filesystem
  = user-owned source and output files
```

进一步讨论过是否直接让 Agent 获取 DuckDB 文件路径、是否引入通用 DuckDB MCP。

结论是：当前项目已经有 Dataset Registry、workspace boundary、read-only SQL guard 和 Evidence provenance。如果直接暴露原始 DuckDB，会让 Agent 更容易绕过这些边界。

因此当前 local_* 工具不是为了包装数据库 API 而包装，而是把“能分析什么、在哪里分析、如何留下 Evidence”固定在工具边界里。

同时刻意没有引入统一 SQL abstraction、Repository/Unit of Work、共享 DuckDB writer、vector DB 或 Lakehouse catalog，因为这些在当前单用户本地场景没有独立价值。

本附录记录设计讨论，不构成新的禁止事项。