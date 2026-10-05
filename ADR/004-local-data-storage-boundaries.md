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
