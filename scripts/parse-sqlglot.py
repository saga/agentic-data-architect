#!/usr/bin/env python3
"""Parse SQL files with SQLGlot and emit a stable JSON structure for TypeScript."""
from __future__ import annotations

import json
import sys

def main() -> int:
    try:
        import sqlglot
        from sqlglot import exp
    except Exception as exc:
        print(json.dumps({"available": False, "error": str(exc)}))
        return 0

    payload = json.load(sys.stdin)
    sql = payload.get("sql", "")
    dialect = payload.get("dialect") or None
    try:
        statements = sqlglot.parse(sql, read=dialect)
        result = []
        for statement in statements:
            if statement is None:
                continue
            kind = statement.key.lower()
            target = None
            if isinstance(statement, exp.Insert):
                target = statement.this
                kind = "insert"
            elif isinstance(statement, exp.Update):
                target = statement.this
                kind = "update"
            elif isinstance(statement, exp.Delete):
                target = statement.this
                kind = "delete"
            elif hasattr(exp, "Merge") and isinstance(statement, exp.Merge):
                target = statement.this
                kind = "merge"
            elif isinstance(statement, exp.Select) or isinstance(statement, exp.Query):
                kind = "select"
            else:
                kind = kind or "statement"

            tables = []
            seen = set()
            target_table = target if isinstance(target, exp.Table) else (target.find(exp.Table) if target is not None else None)
            # Use canonical identifier components rather than rendered SQL. Rendering a
            # Table can include dialect-specific quoting and aliases, which must not become
            # part of the index's stable object name.
            target_name = ".".join(part for part in (target_table.catalog, target_table.db, target_table.name) if part) if target_table is not None else None
            for table in statement.find_all(exp.Table):
                name = ".".join(part for part in (table.catalog, table.db, table.name) if part)
                is_target = bool(target_name and name.lower() == target_name.lower() and kind in {"insert", "update", "delete", "merge"})
                operation = kind if is_target else "select"
                key = (name.lower(), operation)
                if key in seen:
                    continue
                seen.add(key)
                tables.append({"name": name, "operation": operation})
            columns = []
            for column in statement.find_all(exp.Column):
                name = ".".join(part for part in [column.table, column.name] if part)
                if name and name not in columns:
                    columns.append(name)
            result.append({"type": kind, "tables": tables, "columns": columns})
        print(json.dumps({"available": True, "statements": result}))
    except Exception as exc:
        # SQLGlot is installed and ran, but this dialect did not parse the input.
        # Keep this distinct from the import failure above so callers can cache
        # the working interpreter without treating a syntax error as missing SQLGlot.
        print(json.dumps({"available": True, "statements": [], "error": str(exc)}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
