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

至少记录 files scanned、SQL files、parsed statements、parse failures、datasets、已连上线的数据集、column lineage、semantic assets 和 profiled datasets。`datasetLineageConnectionRate` 只是“已连上线的数据集 / 数据集总数”，用于描述发现范围；缺少连接会产生提醒，但不会仅凭这个比例把调查判定为关键阻塞。

Coverage 是确定性事实，不是模型自己给出的置信度。

## Source-of-Truth Candidates

当多个物理 dataset 归到同一个命名键、确实存在选择问题时，系统才根据名称、上下游结构、metadata、semantic context 和 evidence 给出 Source-of-Truth candidate。候选上的 `priorityScore` 只是调查顺序 heuristic，不是 source-of-truth 置信度；没有形成歧义时不生成 candidate，也不会单独推动 Workflow Gate。

candidate != confirmed source of truth。业务权威仍由用户确认；只有确认后的业务/架构结论才进入正式工作产物。

## Semantic Candidates

从 physical schema 和已有 semantic assets 形成 business concept、entity、identifier、metric、temporal dimension 等候选。这些只是“可能的语义”，不会自动变成已确认业务定义。

已有 Snowflake Semantic View、Data Product 或 Catalog 定义应优先作为上下文，而不是重新猜一遍。

## Retrieval

V1.2 不引入 vector database，先使用 SQLite FTS5、名称匹配、graph traversal、semantic assets、source-of-truth candidates 和 findings。
## Local Analytical Plane（DuckDB）

当前 Investigation 的本地数据分析统一使用 DuckDB，文件保持在 workspace，应用状态继续由 SQLite 保存。

~~~text
Uploaded / discovered files
  CSV / JSON / JSONL / Parquet / XLSX
              ↓
       Dataset Registry
              ↓
        DuckDB local plane
          ├─ raw views
          ├─ analysis tables
          └─ scratch tables
              ↓
      profile / query / transform
              ↓
       reconcile / explain
              ↓
            Evidence
~~~

几个重要能力：

- `local_profile` 使用 DuckDB `SUMMARIZE`，一次得到列级 count、NULL 比例、approx unique、min/max、均值和近似分位数。
- `local_reconcile` 用明确的 business keys 和 numeric measures 做 source/target 对账，结果可以直接进入 Validation。
- `local_explain` 用 `EXPLAIN ANALYZE` 获取真实执行信息，用于 SQL / 迁移性能排查。
- XLSX 文件通过 DuckDB Excel extension 进入同一 Dataset Registry；老式 XLS 不属于当前支持范围。
- Parquet 作为推荐的分析中间格式，用于避免把大文件完整塞进模型上下文。

DuckDB 仍然不是权限边界、业务真相或 Investigation State。Agent 只能通过受限的 `local_*` tools 使用已经登记的数据集，分析结果必须保留 Dataset version / SHA-256 / SQL / Evidence。

## Mission-first Investigation

Current-State Intelligence 不是为了不断找未知，而是为了支撑用户明确的 Mission。

对于“看懂当前系统的数据架构”这类任务，通常先覆盖：

~~~text
Data Source
  ↓
Data Flow
  ↓
Data Model
  ↓
Transformation
  ↓
Business Meaning
~~~

少量 unknown 可以保留；只有会影响用户期望结果时才继续调查。具体能力由 skills/current-state-architecture/SKILL.md 提供，不需要新增固定 Workflow。

## Investigation Skills

当前 capability Skill 进一步分成五类：

- `investigation-session`：维护多轮调查状态，区分事实、Evidence、推断和未知。
- `domain-modeling`：当业务术语影响模型、Mapping 或架构决定时统一 canonical language，并关联 Evidence。
- `research`：调查外部事实和第三方能力，优先使用第一方资料并留下可复核的 Research Artifact。
- `grilling`：针对真正需要人决定的业务/架构分叉维护 decision frontier；事实先调查，决定由用户确认。
- `current-state-architecture`：围绕 Data Source、Data Flow、Data Model 和关键 Transformation 梳理现状。

这些 Skill 不增加 Workflow DSL 的复杂度，也不替代权限、Policy 或业务审批。
