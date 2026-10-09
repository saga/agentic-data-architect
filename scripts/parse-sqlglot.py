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
            elif isinstance(statement, exp.Select) or isinstance(statement, exp.Query):
                kind = "select"
            else:
                kind = kind or "statement"

            tables = []
            seen = set()
            target_name = target.sql(dialect=dialect) if isinstance(target, exp.Table) else None
            for table in statement.find_all(exp.Table):
                name = table.sql(dialect=dialect)
                key = (name.lower(), "write" if target_name and name.lower() == target_name.lower() else "read")
                if key in seen:
                    continue
                seen.add(key)
                tables.append({"name": name, "operation": "write" if key[1] == "write" else "select"})
            columns = []
            for column in statement.find_all(exp.Column):
                name = ".".join(part for part in [column.table, column.name] if part)
                if name and name not in columns:
                    columns.append(name)
            result.append({"type": kind, "tables": tables, "columns": columns})
        print(json.dumps({"available": True, "statements": result}))
    except Exception as exc:
        print(json.dumps({"available": False, "error": str(exc)}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
