# ADR-036：Code Structure Index 使用 DuckDB 作为可重建分析投影

- Status: Accepted
- Date: 2026-10-08
- Supersedes: None

## Context

Code Structure Index 已成为移除 Graphify 后的唯一结构分析能力。当前 canonical snapshot 使用 `.code-structure/index.json` 保存文件、节点和关系，并由各语言/工件 extractor 产生。

随着 Java、Python、C#、SQL 等 provider 增加，单纯在 JSON 上执行节点过滤、关系遍历和统计会逐渐产生重复 query logic。与此同时，Data Architecture Investigation 需要把代码结构、SQL 对象和后续 catalog/evidence 数据进行组合分析。

项目已经使用 DuckDB 作为本地分析引擎；但 DuckDB 不能因此成为第二个结构事实源。

## Decision

### 1. Code Structure Index 仍然是 canonical source

`.code-structure/index.json` 是 Code Structure Index 的 authoritative snapshot。

所有 extractor/provider 只产生 `CodeStructureIndex`。节点 ID、关系、confidence 和文件 hash 的语义由该模型定义。

### 2. DuckDB 是 disposable analytical projection

`.code-structure/structure.duckdb` 是从 canonical snapshot 派生的可重建 projection。

它可以删除并由同一个 `CodeStructureIndex` 重新生成，不拥有独立事实。

projection 至少包含：

- `structure_metadata`
- `structure_files`
- `structure_nodes`
- `structure_edges`

不得让业务代码直接修改这些表来改变结构事实。

### 3. Query Layer 使用 DuckDB

结构查询逐步通过明确的 query boundary 访问 projection：

- `find`
- `callers`
- `callees`
- bounded `trace`
- `summary`

查询层负责 SQL 和 projection schema；上层不依赖 DuckDB API。

`CodeStructureIndexProvider` 在成功生成 canonical JSON 后同步刷新 DuckDB projection，保证同一次 build 的两个派生结果来自同一个 snapshot。

### 4. 不把 DuckDB 变成图数据库

不引入 graph database、NetworkX、Neo4j、community detection、centrality 或 embedding graph，只为了复刻 Graphify。

关系仍然是普通 typed edges；需要的有限路径查询使用有界递归 SQL。

### 5. 与 Investigation persistence 保持边界

本 ADR 不改变 ADR-027 的 persistence boundary：

- `context.json`：Investigation business state；
- `conversations.db`：application/conversation state；
- `local.duckdb`：Investigation analytical data；
- `.code-structure/index.json`：canonical structural snapshot；
- `.code-structure/structure.duckdb`：structural analytical projection；
- filesystem artifacts：用户可复查的结果和中间资料。

Code Structure projection 不承担 workflow、conversation 或 Mission state。

## Projection refresh and failure semantics

- Refresh the DuckDB projection through the same cached DuckDB instance used by query clients. Do not open a competing instance for the same database file while readers may still hold cached handles.
- Write the canonical JSON snapshot atomically (temporary file followed by rename) so a process interruption cannot leave a truncated authoritative snapshot.
- JSON persistence and DuckDB projection are separate outcomes. If JSON persistence succeeds but projection refresh fails, the build must report the saved canonical snapshot path and the projection failure explicitly. Consumers must not interpret that error as proof that no new canonical snapshot exists, and must not assume the projection is current.
- A failed projection is recoverable by rerunning the structure-index build; DuckDB remains disposable and must not be treated as an independent source of truth.

## Consequences

- 结构 extractor 不需要关心查询实现。
- JSON snapshot 仍然可以独立 diff、审查和重建。
- DuckDB 可以高效执行跨节点、跨关系的分析查询。
- 后续可以把 Catalog Query / Projection Layer 扩展到结构、catalog、lineage 和 evidence，而不再复制 JSON traversal。
- DuckDB 文件损坏或删除不会破坏 canonical structure facts，只需要重新 projection。

## Rejected alternatives

### A. 直接把 DuckDB 作为 Code Structure Index 的 canonical store

拒绝。这样会让 parser/model 和数据库 schema 形成双重事实边界，降低 snapshot 的可复查性和 portability。

### B. 使用 SQLite 代替 DuckDB

拒绝作为当前结构分析 projection。SQLite 仍适合 application state，但 repository structure 的 aggregation、join 和 analytical query 更符合 DuckDB 的职责。

### C. 重新引入 Graphify / graph database

拒绝。当前需求是确定性结构事实和有限查询，不需要通用 graph platform。
