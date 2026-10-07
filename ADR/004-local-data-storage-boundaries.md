# ADR-004：SQLite、DuckDB、Parquet 和文件系统职责分离

- Status: Superseded
- Date: 2026-10-05
- Superseded by: [ADR-027](./027-investigation-state-persistence-boundary.md)

## Context

项目需要同时保存 Investigation 状态、对话、数据集登记、本地分析结果和用户原始文件。

原决定把 SQLite、DuckDB、Parquet 和文件系统的职责分开，但当时没有把“SQLite 是应用级存储”和“Investigation 当前状态由 workspace context 保存”这两个层次说清楚。

## Decision

本 ADR 的历史决定已经由 ADR-027 取代。

当前实现和后续开发统一以 ADR-027 为准，不再从本 ADR 的旧表述推导新的存储边界。

## Consequences

历史上的 SQLite / DuckDB / Parquet / Filesystem 分工仍作为演进背景保留，但不再作为独立的规范来源。

## Related

- ADR-027：Investigation State 与本地分析存储边界
- ADR-012：Soul / Relationship Memory isolation
