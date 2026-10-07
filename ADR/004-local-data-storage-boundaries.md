# ADR-004：SQLite、DuckDB、Parquet 和文件系统职责分离

- Status: Superseded
- Date: 2026-10-05

## Context

项目需要同时保存 Investigation 状态、对话、数据集登记、本地分析结果和用户原始文件。

把所有内容塞进一个数据库会让应用状态和 analytical workload 互相影响，也会削弱文件数据的可移植性。

## Decision

职责固定为：

- `.workspace/<session>/context.json`：当前 Investigation 业务状态的 canonical persistence boundary；
- SQLite：应用级状态存储，包括对话、Investigation 的 Dataset Registry 和 analysis run metadata；
- DuckDB：每个 Investigation 独立的本地分析引擎；
- Parquet：大型分析数据和可移植中间结果；
- Filesystem：原始输入和用户可直接打开的报告/产物。

每个 Investigation 使用自己的 local.duckdb。

Agent 不直接拿 DuckDB 文件路径；本地数据通过 local_catalog、local_register_dataset、local_describe、local_sample、local_profile、local_query 等受控工具访问。

应用拥有的 conversation history 属于 SQLite application state。需要跨 Investigation 找历史对话时，使用应用自己的查询/检索能力；当前实现可使用 SQLite FTS5 做文本检索，但它不是 Research Knowledge 或 Evidence Store。

Relationship Memory 与 conversation history 不混为一谈：Relationship Memory 保持独立的长期关系状态边界，Research Knowledge 与 Evidence 继续遵循各自 ADR。

## Consequences

- 应用状态和 analytical data boundary 清晰；
- DuckDB 能保持本地分析能力；
- Parquet 便于大结果继续被其他工具使用；
- Agent 不能绕过 Dataset Registry 和 Evidence provenance；
- Conversation history 可以持久化并按应用语义检索，而不会成为事实系统。

代价是系统需要维护 Dataset Registry 与本地文件版本之间的关系，并在工具层承担 SQL/path guard。

## Related

- ADR-012：Soul / Relationship Memory isolation
- ADR-027：Investigation State 与本地分析存储边界

> 当前实现边界由 ADR-027 进一步明确：SQLite 是应用级持久化组件，但不取代 `context.json` 作为 Investigation 状态的 canonical source。
