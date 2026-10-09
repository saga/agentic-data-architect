# ADR-038: SQL Dialect Parsing, Lineage Confidence, and Coverage

- Status: Accepted
- Date: 2026-10-09
- Related: ADR-035

## Context

The repository has two SQL consumers with different purposes: the Code Structure Index supports source navigation and syntactic references; the SQL lineage pipeline derives dataset and column relationships. Both use SQLGlot, but their output contracts and error handling have differed. Dialect detection is heuristic, and parser success cannot guarantee complete semantic coverage.

## Decision

1. Keep the two consumers separate because their output models and use cases differ. Do not treat structure-index `references` edges as column lineage.
2. Make dialect detection an explicit, inspectable heuristic. Return the selected dialect with lineage parse results. A detected dialect is a parser choice, not proof that every construct is supported.
3. Preserve parse and AST extraction failures per statement. A successful statement must not hide a failed statement in the same file. Consumers must expose failures and coverage limitations rather than silently interpreting missing edges as absence of dependencies.
4. Do not label inferred joins, ambiguous column resolution, or unsupported constructs as exact lineage. Keep direct syntactic table access separate from derived source-to-target column mappings.
5. Keep Oracle support scoped accurately: static SQL dialect parsing is not Oracle live database discovery or complete PL/SQL package/procedure analysis. The structure index currently scans `.sql`, `.ddl`, `.dml`, and `.hql`; additional extensions require explicit support and fixtures.
6. Keep read-only SQL validation as defense in depth. Database-enforced read-only credentials and least privilege remain necessary.
7. Add dialect-specific fixture tests for PostgreSQL, Oracle, Snowflake, CTEs, nested queries, INSERT/SELECT, MERGE, parse failures, and lineage mapping when parser behavior changes.
8. For MERGE, emit target-to-source dataset dependencies but do not infer column-level mappings from WHEN clauses until their semantics can be resolved reliably.
9. Preserve source line locations on structural statement nodes and edges; where a parser provides no locations, use statement splitting as a best-effort fallback and document procedural SQL limitations.

## Consequences

- Parse failures and selected dialects are observable to the lineage caller.
- Reports can distinguish parsed facts, inferred relationships, and unknown coverage.
- Static parser capability cannot be advertised as live database-adapter support.
- The structure index and lineage pipeline can evolve independently while sharing test expectations and clearly documented semantic boundaries.

## Non-goals

- No Oracle database adapter in this change.
- No claim of complete PL/SQL, stored procedure, dynamic SQL, or `SELECT *` lineage.
- No graph database or wholesale parser rewrite.
