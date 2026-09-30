#!/usr/bin/env python3
"""SQLGlot 解析桥：stdin JSON -> stdout JSON。

输入:  {"sql": "...", "dialect": "postgres" | null}
输出:  {"statements": [Statement], "error": null | str}

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
顶层整体解析失败时 statements=[] 且 error 有值；单个 statement 失败则跳过该条。
列解析是启发式的：SELECT * 无 schema 时记为 sourceColumn="*"。
"""
import json
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


def alias_map(query: exp.Expression) -> dict:
    """FROM/JOIN 中的别名 -> 真实表名或 CTE 名。"""
    mapping = {}
    for scope in (query.args.get("from"),):
        pass
    for from_ in query.find_all(exp.From):
        for src in from_.find_all(exp.Table):
            parent_alias = src.find_ancestor(exp.Alias)
            name = table_name(src)
            if parent_alias:
                mapping[parent_alias.alias_or_name.lower()] = name
            if src.name:
                mapping.setdefault(src.name.lower(), name)
    for join in query.find_all(exp.Join):
        for src in join.find_all(exp.Table):
            parent_alias = src.find_ancestor(exp.Alias)
            name = table_name(src)
            if parent_alias:
                mapping[parent_alias.alias_or_name.lower()] = name
            if src.name:
                mapping.setdefault(src.name.lower(), name)
    # CTE 引用本身：FROM cte 名（无 Table 节点时补上，保持小写原名）
    return mapping


def resolve_cte(statement: exp.Expression) -> dict:
    mapping = {}
    for cte in statement.find_all(exp.CTE):
        mapping[cte.alias_or_name.lower()] = cte.this
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
    for proj in selects:
        if isinstance(proj, exp.Star):
            outputs.append({"name": "*", "refs": star_refs(query, aliases, ctes, depth), "expr": proj.sql()})
            continue
        name = proj.alias_or_name or f"col_{len(outputs)}"
        refs = []
        for col in proj.find_all(exp.Column):
            refs.extend(resolve_column(col, aliases, ctes, depth))
        outputs.append({"name": name, "refs": refs, "expr": proj.sql()})
    return outputs


def star_refs(query, aliases, ctes, depth):
    tables = {table_name(t).lower(): table_name(t) for t in query.find_all(exp.Table)}
    refs = []
    for alias, real in aliases.items():
        key = real.lower()
        if key in ctes and depth < 8:
            for o in query_outputs(ctes[key], ctes, depth + 1):
                refs.append({"table": real, "column": o["name"]})
        elif key in tables or real:
            refs.append({"table": real, "column": "*"})
    for key, real in tables.items():
        if key not in ctes and not any(r["table"] == real for r in refs):
            refs.append({"table": real, "column": "*"})
    return refs


def resolve_column(col: exp.Column, aliases: dict, ctes: dict, depth: int) -> list:
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
    if isinstance(statement, (exp.Select, exp.Union)):
        return None, "select", statement
    return None, "other", None


def analyze_statement(statement: exp.Expression) -> dict:
    target, kind, inner = target_of(statement)
    query = inner if isinstance(inner, (exp.Select, exp.Union)) else (
        statement if kind == "select" else None)
    ctes = resolve_cte(statement)
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
        "sources": base_sources(statement),
        "columns": columns,
        "sql": statement.sql(),
    }


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"statements": [], "error": f"bad stdin: {e}"}))
        return
    sql, dialect = payload.get("sql", ""), payload.get("dialect")
    try:
        parsed = sqlglot.parse(sql, read=dialect) if dialect else sqlglot.parse(sql)
    except Exception as e:
        print(json.dumps({"statements": [], "error": f"parse failed: {e}"}))
        return
    out = []
    for stmt in parsed:
        if stmt is None:
            continue
        try:
            out.append(analyze_statement(stmt))
        except Exception:
            continue
    print(json.dumps({"statements": out, "error": None}))


if __name__ == "__main__":
    main()
