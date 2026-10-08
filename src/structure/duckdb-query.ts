import { DuckDBInstance } from '@duckdb/node-api';
import type { CodeEdge, CodeNode, StructurePath, StructureQuery } from './types.js';

export interface StructureSummary {
  files: number;
  nodes: number;
  edges: number;
  nodesByKind: Array<{ kind: string; count: number }>;
  edgesByKind: Array<{ kind: string; count: number }>;
}

export class CodeStructureDuckDBQuery {
  constructor(private readonly databaseFile: string) {}

  async find(query: StructureQuery): Promise<CodeNode[]> {
    const instance = await DuckDBInstance.fromCache(this.databaseFile);
    const connection = await instance.connect();
    try {
      const text = query.text ? '%' + escapeLike(query.text) + '%' : '%';
      const reader = await connection.runAndReadAll(
        "SELECT id, kind, name, file, line FROM structure_nodes WHERE lower(name) LIKE lower($1) ESCAPE '\\' AND ($2 IS NULL OR kind = $2) AND ($3 IS NULL OR file = $3 OR file LIKE $3 || '/%') ORDER BY file, kind, name, id LIMIT $4",
        [text, query.kind ?? null, query.file ?? null, query.limit ?? 100],
      );
      return reader.getRowObjects().map(row => ({
        id: String(row.id),
        kind: String(row.kind) as CodeNode['kind'],
        name: String(row.name),
        file: String(row.file),
        ...(row.line == null ? {} : { line: Number(row.line) }),
      }));
    } finally {
      connection.disconnectSync();
    }
  }

  async callers(nodeId: string): Promise<CodeNode[]> {
    return this.related(nodeId, 'to');
  }

  async callees(nodeId: string): Promise<CodeNode[]> {
    return this.related(nodeId, 'from');
  }

  async trace(fromNodeId: string, toNodeId: string, maxDepth = 8): Promise<StructurePath | undefined> {
    const instance = await DuckDBInstance.fromCache(this.databaseFile);
    const connection = await instance.connect();
    try {
      // 把递归路径留在 DuckDB 内部展开，而不是把 JS string[] 当成 SQL 参数。
      // @duckdb/node-api 的参数类型不把普通 JavaScript 数组视为 DuckDB LIST，因此后续节点/边查询
      // 统一通过同一个 target_path CTE 处理，也避免在 Node 端拼接 SQL。
      const pathCte = `WITH RECURSIVE paths(node_id, depth, path) AS (
        SELECT $1::VARCHAR, 0, [$1::VARCHAR]
        UNION ALL
        SELECT e.to_id, p.depth + 1, array_append(p.path, e.to_id)
        FROM paths p
        JOIN structure_edges e
          ON e.from_id = p.node_id
         AND e.kind = 'calls'
        WHERE p.depth < $3
          AND NOT list_contains(p.path, e.to_id)
      ),
      target_path AS (
        SELECT path
        FROM paths
        WHERE node_id = $2
        ORDER BY depth
        LIMIT 1
      ) `;

      const nodeReader = await connection.runAndReadAll(
        pathCte + `
          SELECT u.ord,
                 n.id,
                 n.kind,
                 n.name,
                 n.file,
                 n.line
          FROM target_path,
               UNNEST(target_path.path) WITH ORDINALITY AS u(node_id, ord)
          JOIN structure_nodes n ON n.id = u.node_id
          ORDER BY u.ord
        `,
        [fromNodeId, toNodeId, maxDepth],
      );
      const nodeRows = nodeReader.getRowObjects().map(row => ({
        id: String(row.id),
        kind: String(row.kind) as CodeNode['kind'],
        name: String(row.name),
        file: String(row.file),
        ...(row.line == null ? {} : { line: Number(row.line) }),
      }));
      if (!nodeRows.length) return undefined;

      const edgeReader = await connection.runAndReadAll(
        pathCte + `
          SELECT e.from_id,
                 e.to_id,
                 e.kind,
                 e.confidence,
                 e.file,
                 e.line
          FROM target_path,
               UNNEST(target_path.path) WITH ORDINALITY AS u(node_id, ord)
          JOIN UNNEST(target_path.path) WITH ORDINALITY AS v(next_node_id, next_ord)
            ON v.next_ord = u.ord + 1
          JOIN structure_edges e
            ON e.from_id = u.node_id
           AND e.to_id = v.next_node_id
           AND e.kind = 'calls'
        `,
        [fromNodeId, toNodeId, maxDepth],
      );
      const edgeRows = edgeReader.getRowObjects();

      const byId = new Map(nodeRows.map(node => [node.id, node]));
      const edges: CodeEdge[] = edgeRows.map(edge => ({
        from: String(edge.from_id),
        to: String(edge.to_id),
        kind: 'calls',
        confidence: String(edge.confidence) as 'exact' | 'inferred',
        ...(edge.file == null ? {} : { file: String(edge.file) }),
        ...(edge.line == null ? {} : { line: Number(edge.line) }),
      }));
      return { nodes: nodeRows, edges };
    } finally {
      connection.disconnectSync();
    }
  }

  async summary(): Promise<StructureSummary> {
    const instance = await DuckDBInstance.fromCache(this.databaseFile);
    const connection = await instance.connect();
    try {
      const counts = await connection.runAndReadAll("SELECT (SELECT count(*) FROM structure_files) AS files, (SELECT count(*) FROM structure_nodes) AS nodes, (SELECT count(*) FROM structure_edges) AS edges");
      const row = counts.getRowObjects()[0] as Record<string, number | bigint>;
      const nodes = (await connection.runAndReadAll('SELECT kind, count(*) AS count FROM structure_nodes GROUP BY kind ORDER BY kind')).getRowObjects() as Array<{ kind: string; count: number | bigint }>;
      const edges = (await connection.runAndReadAll('SELECT kind, count(*) AS count FROM structure_edges GROUP BY kind ORDER BY kind')).getRowObjects() as Array<{ kind: string; count: number | bigint }>;
      return {
        files: Number(row.files), nodes: Number(row.nodes), edges: Number(row.edges),
        nodesByKind: nodes.map(item => ({ kind: item.kind, count: Number(item.count) })),
        edgesByKind: edges.map(item => ({ kind: item.kind, count: Number(item.count) })),
      };
    } finally {
      connection.disconnectSync();
    }
  }

  private async related(nodeId: string, side: 'from' | 'to'): Promise<CodeNode[]> {
    const instance = await DuckDBInstance.fromCache(this.databaseFile);
    const connection = await instance.connect();
    try {
      const sourceColumn = side === 'to' ? 'from_id' : 'to_id';
      const targetColumn = side === 'to' ? 'to_id' : 'from_id';
      const sql = "SELECT n.id, n.kind, n.name, n.file, n.line FROM structure_nodes n JOIN structure_edges e ON e." + sourceColumn + " = n.id WHERE e.kind = 'calls' AND e." + targetColumn + " = $1 ORDER BY n.file, n.kind, n.name, n.id";
      return (await connection.runAndReadAll(sql, [nodeId])).getRowObjects().map(row => ({
        id: String(row.id),
        kind: String(row.kind) as CodeNode['kind'],
        name: String(row.name),
        file: String(row.file),
        ...(row.line == null ? {} : { line: Number(row.line) }),
      }));
    } finally {
      connection.disconnectSync();
    }
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, char => '\\' + char);
}
