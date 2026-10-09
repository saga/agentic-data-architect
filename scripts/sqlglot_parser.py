#!/usr/bin/env python3
"""SQLGlot 解析桥：stdin JSON -> stdout JSON。

输入:  {"sql": "...", "dialect": "postgres" | null}
输出:  {"statements": [Statement], "failures": [Failure], "dialect": str | null, "error": null | str}

Statement = {
  "target": "schema.table" | null,   # CREATE VIEW/TABLE AS / INSERT INTO
  "kind": "create_view" | "create_table" | "insert" | "select" | "other",
  "sources": ["t1", ...],            # 去掉 CTE 名之后的基础表
  "columns": [                        # L2 列级血缘（尽力而为）
    {"targetColumn": "mv", "sourceDataset": "t",
     "sourceColumn": "c", "expression": "qty * price"}
  ],
  "sql": "<statement text>",
}
顶层解析失败时 statements=[] 且 error 有值；AST 提取失败会写入 failures，避免静默跳过。实际选择的 dialect 会随结果返回。
列解析是启发式的：SELECT * 无 schema 时记为 sourceColumn="*"。
"""
import json
import re
import sys

try:
    import sqlglot
    from sqlglot import exp
except ImportError as e:  # pragma: no cover
    print(json.dumps({"statements": [], "error": f"sqlglot not installed: {e}"}))
    sys.exit(0)


def table_name(table: exp.Table) -> str:
    parts = [p for p in (table.catalog, table.db, table.name) if p]
    return ".".join(parts)


def cte_names(statement: exp.Expression) -> set:
    names = set()
    for cte in statement.find_all(exp.CTE):
        alias = cte.alias_or_name
        if alias:
            names.add(alias.lower())
    return names


def base_sources(statement: exp.Expression) -> list:
    ctes = cte_names(statement)
    out, seen = [], set()
    for table in statement.find_all(exp.Table):
        name = table_name(table)
        if not name or name.lower() in ctes:
            continue
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def alias_of(node: exp.Expression) -> str:
    """Table / Alias 节点上带的别名（sqlglot 30 把表别名存在 Table.args 里）。"""
    alias = node.args.get("alias")
    if alias is None:
        return ""
    if isinstance(alias, exp.Expression):
        return alias.alias_or_name or alias.name or ""
    return str(alias)


def alias_map(query: exp.Expression) -> dict:
    """FROM/JOIN 中的别名 -> 真实表名。只收本查询层级的，避免子查询污染外层。"""
    mapping = {}
    for table in query.find_all(exp.Table):
        if _scope_of(table) is not query:
            continue
        name = table_name(table)
        alias = alias_of(table)
        if alias:
            mapping[alias.lower()] = name
        if table.name:
            mapping.setdefault(table.name.lower(), name)
    return mapping


def resolve_cte(statement: exp.Expression) -> dict:
    mapping = {}
    for cte in statement.find_all(exp.CTE):
        mapping[cte.alias_or_name.lower()] = cte.this
    return mapping


from typing import Optional


def _scope_of(node: exp.Expression) -> Optional[exp.Expression]:
    """节点所属的最近查询层（Select / Union），派生表归属判定用。"""
    parent = node.parent
    while parent is not None:
        if isinstance(parent, (exp.Select, exp.Union)):
            return parent
        parent = parent.parent
    return None


def subquery_map(query: exp.Expression) -> dict:
    """FROM/JOIN 里的派生表别名 -> 子查询 Select（只收本查询层级的）。"""
    mapping = {}
    for from_ in list(query.find_all(exp.From)) + list(query.find_all(exp.Join)):
        if _scope_of(from_) is not query:
            continue
        for sub in from_.find_all(exp.Subquery, exp.Alias):
            if _scope_of(sub) is not query:
                continue
            inner = sub.args.get("this")
            if not isinstance(inner, (exp.Select, exp.Union)):
                continue
            name = alias_of(sub)
            if name:
                mapping[name.lower()] = inner
    return mapping


def query_outputs(query: exp.Expression, ctes: dict, depth: int = 0) -> list:
    """返回 [{name, refs: [{table, column}], expr}]。depth 防递归 CTE。"""
    outputs = []
    selects = query.selects if isinstance(query, exp.Select) else []
    if not query or depth > 8:
        return outputs
    if isinstance(query, exp.Union):
        for branch in (query.left, query.right):
            outputs.extend(query_outputs(branch, ctes, depth + 1))
        return outputs
    if not isinstance(query, exp.Select):
        return outputs
    aliases = alias_map(query)
    derived = subquery_map(query)
    for proj in selects:
        if isinstance(proj, exp.Star):
            outputs.append({"name": "*", "refs": star_refs(query, aliases, ctes, derived, depth), "expr": proj.sql()})
            continue
        name = proj.alias_or_name or f"col_{len(outputs)}"
        refs = []
        for col in proj.find_all(exp.Column):
            refs.extend(resolve_column(col, aliases, ctes, derived, depth))
        outputs.append({"name": name, "refs": refs, "expr": proj.sql()})
    return outputs


def star_refs(query, aliases, ctes, derived, depth):
    tables = {table_name(t).lower(): table_name(t) for t in query.find_all(exp.Table)}
    refs = []
    for alias, real in aliases.items():
        key = real.lower()
        if key in ctes and depth < 8:
            for o in query_outputs(ctes[key], ctes, depth + 1):
                refs.append({"table": real, "column": o["name"]})
        elif derived_columns(derived, real, depth, ctes):
            refs.extend(derived_columns(derived, real, depth, ctes))
        elif key in tables or real:
            refs.append({"table": real, "column": "*"})
    for key, real in tables.items():
        if key not in ctes and not any(r["table"] == real for r in refs):
            refs.append({"table": real, "column": "*"})
    return refs


def derived_columns(derived: dict, real: str, depth: int, ctes: dict) -> list:
    if real.lower() in derived and depth < 8:
        return [
            {"table": real, "column": o["name"]}
            for o in query_outputs(derived[real.lower()], ctes, depth + 1)
        ]
    return []


def resolve_column(col: exp.Column, aliases: dict, ctes: dict, derived: dict, depth: int) -> list:
    qualifier = (col.table or "").lower()
    col_name = col.name
    real = aliases.get(qualifier, qualifier) if qualifier else ""
    if real.lower() in ctes and depth < 8:
        inner = query_outputs(ctes[real.lower()], ctes, depth + 1)
        matched = [o for o in inner if o["name"].lower() == col_name.lower()]
        picked = matched or inner
        refs = []
        for o in picked:
            refs.extend(o["refs"] or [{"table": real, "column": o["name"]}])
        return refs
    if real.lower() in derived and depth < 8:
        inner = query_outputs(derived[real.lower()], ctes, depth + 1)
        matched = [o for o in inner if o["name"].lower() == col_name.lower()]
        picked = matched or inner
        refs = []
        for o in picked:
            refs.extend(o["refs"] or [{"table": real, "column": o["name"]}])
        return refs
    if real:
        return [{"table": real, "column": col_name}]
    # 无限定列：唯一源表时归因，否则保留空表名（下游按 unknowns 处理）
    tables = {table_name(t) for t in col.find_ancestor(exp.Select).find_all(exp.Table)} if col.find_ancestor(exp.Select) else set()
    if len(tables) == 1:
        return [{"table": next(iter(tables)), "column": col_name}]
    return [{"table": "", "column": col_name}]


def target_of(statement: exp.Expression):
    if isinstance(statement, exp.Create):
        this = statement.this
        kind = statement.args.get("kind", "").upper()
        name = ""
        inner = None
        if isinstance(this, exp.Schema):
            name = table_name(this.this) if isinstance(this.this, exp.Table) else this.sql()
            inner = statement.args.get("expression")
        elif isinstance(this, exp.Table):
            name = table_name(this)
            inner = statement.args.get("expression")
        label = "create_view" if kind == "VIEW" else "create_table" if kind == "TABLE" else "create"
        return name or None, label, inner
    if isinstance(statement, exp.Insert):
        this = statement.this
        name = ""
        if isinstance(this, exp.Schema) and isinstance(this.this, exp.Table):
            name = table_name(this.this)
        elif isinstance(this, exp.Table):
            name = table_name(this)
        return name or None, "insert", statement.args.get("expression")
    # MERGE has a write target and one or more read sources, but its WHEN clauses
    # are not a normal SELECT projection. Preserve dataset lineage without claiming
    # column-level mappings that this extractor cannot reliably resolve.
    if hasattr(exp, "Merge") and isinstance(statement, exp.Merge):
        this = statement.this
        name = table_name(this) if isinstance(this, exp.Table) else ""
        return name or None, "merge", None
    if isinstance(statement, (exp.Select, exp.Union)):
        return None, "select", statement
    return None, "other", None


def analyze_statement(statement: exp.Expression) -> dict:
    target, kind, inner = target_of(statement)
    query = inner if isinstance(inner, (exp.Select, exp.Union)) else (
        statement if kind == "select" else None)
    ctes = resolve_cte(statement)
    target_lower = (target or "").lower()
    # 目标表本身也是 exp.Table 节点，必须排除，否则出现 v -> v 自环
    sources = [s for s in base_sources(statement) if s.lower() != target_lower]
    columns = []
    if query is not None:
        for o in query_outputs(query, ctes):
            for ref in o["refs"]:
                if not ref["table"]:
                    continue
                columns.append({
                    "targetColumn": o["name"],
                    "sourceDataset": ref["table"],
                    "sourceColumn": ref["column"],
                    "expression": o["expr"],
                })
    return {
        "target": target,
        "kind": kind,
        "sources": sources,
        "columns": columns,
        "sql": statement.sql(),
    }


def detect_dialect(sql: str, configured: str | None) -> str | None:
    """Heuristically detect strong dialect syntax; fall back to caller configuration.

    This is deliberately a syntax-signal heuristic, not a SQL lexer. Comments and
    string literals can still contain matching tokens, so callers should prefer an
    explicit dialect when the source format is known.
    """
    text = sql.lower()
    oracle = (
        r"\b(?:varchar2|nvarchar2|sysdate|systimestamp|dual|connect\s+by)\b",
        r"\bnumber\s*\(",
        r"\b(?:dbms|utl)_[a-z0-9_$]+\b",
        r"\bpragma\s+autonomous_transaction\b",
    )
    postgres = (
        r"::\s*[a-z_][\w.]*(?:\[\])?",
        r"\b(?:serial|bigserial|smallserial|ilike|returning|jsonb|plpgsql)\b",
        r"\bdistinct\s+on\s*\(",
        r"\$[a-z_]*\$",
    )
    snowflake = (
        r"\b(?:qualify|flatten|variant|object_construct|parse_json)\b",
        r"\bcopy\s+into\b",
        r"\bsnowflake\.account_usage\b",
    )
    if any(re.search(pattern, text) for pattern in oracle):
        return "oracle"
    if any(re.search(pattern, text) for pattern in postgres):
        return "postgres"
    if any(re.search(pattern, text) for pattern in snowflake):
        return "snowflake"
    return configured.lower() if configured else None


def parse_one(sql: str, dialect) -> dict:
    selected_dialect = detect_dialect(sql, dialect)
    try:
        parsed = sqlglot.parse(sql, read=selected_dialect) if selected_dialect else sqlglot.parse(sql)
    except Exception as e:
        return {"statements": [], "failures": [{"statementIndex": 0, "error": f"parse failed ({selected_dialect or 'generic'}): {e}"}], "dialect": selected_dialect, "error": f"parse failed: {e}"}
    out, failures = [], []
    for index, stmt in enumerate(parsed):
        if stmt is None:
            failures.append({"statementIndex": index, "error": "SQL parser returned an empty statement"})
            continue
        try:
            out.append(analyze_statement(stmt))
        except Exception as e:
            failures.append({"statementIndex": index, "error": f"AST extraction failed: {e}"})
    return {"statements": out, "failures": failures, "dialect": selected_dialect, "error": None}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"statements": [], "error": f"bad stdin: {e}"}))
        return
    if "batch" in payload:
        results = [
            parse_one(item.get("sql", ""), item.get("dialect"))
            for item in payload["batch"]
        ]
        print(json.dumps({"results": results}))
        return
    sql, dialect = payload.get("sql", ""), payload.get("dialect")
    print(json.dumps(parse_one(sql, dialect)))


if __name__ == "__main__":
    main()
