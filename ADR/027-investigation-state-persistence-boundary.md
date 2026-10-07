# ADR-027：Investigation State 与本地分析存储边界

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Investigation state persistence, conversation history, local analytical data

## Context

当前实现已经形成稳定的本地持久化边界，但“SQLite 是 application state”容易被理解成所有 Investigation 状态字段都必须放进 SQLite。

实际实现中，Investigation 的完整业务状态需要和 workspace 文件、Discovery Snapshot、报告和 artifacts 一起保存和复查；Conversation、Dataset Registry 和 Analysis Run 则由同一个 SQLite store 管理。

## Decision

### 1. Investigation State

`.workspace/<session>/context.json` 是当前 Investigation 业务状态的 canonical persistence boundary，负责：

- Mission / Goal / Scope / Systems；
- Discovery Runs；
- Evidence / Claims / Findings / Unknowns；
- 当前 Workflow selection / Journey plan；
- Workspace inputs 和可恢复运行信息。

Context 使用 runtime schema validation，并通过 workspace lock + atomic rename 保存。

### 2. SQLite Application Store

`.workspace/conversations.db` 是应用级 SQLite store，负责：

- Conversation messages；
- Conversation turns；
- SQLite FTS5 conversation search；
- Local Dataset Registry；
- Local Analysis Run metadata。

这些数据属于 application state，但不是 `context.json` 的替代状态源。

### 3. DuckDB

每个 Investigation 的 `local.duckdb` 是分析引擎，不承担 Investigation application state，也不作为 Agent 的直接文件访问入口。

### 4. Filesystem Artifacts

原始上传、Discovery snapshots、reports 和 analysis artifacts 保存在 Investigation workspace。它们是可直接复查的工作产物，不与 SQLite 对话状态混成一个数据模型。

### 5. Source of Truth Boundary

不要在 Context、SQLite、DuckDB 或报告之间再创建第二套 Investigation 状态模型：

- 当前 Investigation 事实状态：`context.json`；
- 对话和本地数据分析 metadata：`conversations.db`；
- 数据分析计算：`local.duckdb`；
- 用户可打开的结果和中间资料：Filesystem artifacts。

如果以后要把 Investigation state 迁入 SQLite，必须同时更新本 ADR 和相关 contract，不允许悄悄形成第二套事实源。

## Consequences

- Investigation 可以完整地作为 workspace 单元保存和复制。
- SQLite 不需要承载大量结构化 Evidence / Snapshot JSON。
- Conversation、Dataset Registry 和 Analysis Run 可以继续共享一个本地 SQLite 文件。
- 各类 durable data 的 owner 更清楚，避免把“SQLite 是 SoR”理解成唯一物理存储。

## Related

- ADR-004：已由本 ADR supersede
- ADR-019：Derived State Semantic Consistency
- ADR-020：Runtime Event、HTTP Error 与 Durable Data Contract
