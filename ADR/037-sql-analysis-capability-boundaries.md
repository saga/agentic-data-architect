# ADR-037: SQL Analysis Capability Boundaries and Evidence Quality

- Status: Accepted
- Date: 2026-10-09
- Supersedes: None

## Context

The repository has separate SQL consumers:

- Code Structure Index extracts statement/table/column-reference facts for structural navigation.
- SQLGlot lineage extracts dataset dependencies and best-effort column mappings for data architecture discovery.
- PostgreSQL and Snowflake adapters discover live database metadata and optionally profile data.

These capabilities overlap in terminology but do not provide the same guarantees. A parser may accept a statement while failing to recover some semantic dependencies. Heuristic dialect detection is also not equivalent to full dialect support.

## Decision

1. **Keep the three capability boundaries explicit.** Structural column references must not be described as column lineage. Static Oracle dialect parsing must not be described as Oracle live database discovery.
2. **Treat dialect detection as a hint.** Detection may choose an initial SQLGlot dialect, but it is not proof that a file uses only that dialect or that all of its semantics were recovered.
3. **Preserve uncertainty.** Parse failures and unsupported constructs must remain observable. Consumers must not interpret parser success alone as complete lineage coverage.
4. **Use dialect-specific regression fixtures.** Changes to dialect detection or SQL extraction should include representative tests for each affected dialect, including target/source dependencies and column mapping where applicable.
5. **Do not claim Oracle live database support until an Oracle adapter exists.** PL/SQL packages and procedure files are also outside the current SQL structure scanner's extension list.
6. **Do not unify the two SQL pipelines solely to remove code duplication.** Share stable parser utilities and test fixtures where practical, while keeping structural navigation and lineage semantics separate.

## Current implementation status

- SQL structure scanning includes `.sql`, `.ddl`, `.dml`, and `.hql`.
- The structure provider attempts SQLGlot and falls back to `node-sql-parser`.
- Dialect selection includes heuristic signals for PostgreSQL, Oracle, and Snowflake; fallback parsing is best-effort.
- Live database discovery currently provides PostgreSQL and Snowflake adapters.
- SQLGlot lineage has explicit handling for common CTE, derived-table, and expression cases, but complex scopes, star expansion without metadata, dynamic SQL, stored procedures, and vendor-specific procedural constructs may remain incomplete.

## Consequences

- Reports and skills must distinguish observed facts, inferred relationships, and unknown coverage.
- Documentation should describe the actual capability and its limits rather than broad dialect-level support.
- Regression tests become the acceptance evidence for parser improvements; adding a dialect keyword alone is insufficient.
