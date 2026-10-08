import { DuckDBInstance } from '@duckdb/node-api';
import type { CodeNode, StructurePath, StructureQuery } from './types.js';

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
      return reader.getRowObjects() as CodeNode[];
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
      const reader = await connection.runAndReadAll(
        "WITH RECURSIVE paths(node_id, depth, path) AS (SELECT $1::VARCHAR, 0, [$1::VARCHAR] UNION ALL SELECT e.to_id, p.depth + 1, array_append(p.path, e.to_id) FROM paths p JOIN structure_edges e ON e.from_id = p.node_id AND e.kind = 'calls' WHERE p.depth < $3 AND NOT list_contains(p.path, e.to_id)) SELECT path FROM paths WHERE node_id = $2 ORDER BY depth LIMIT 1",
        [fromNodeId, toNodeId, maxDepth],
      );
      const row = reader.getRows()[0] as string[] | undefined;
      if (!row) return undefined;
      const nodesReader = await connection.runAndReadAll(
        'SELECT id, kind, name, file, line FROM structure_nodes WHERE id IN (SELECT UNNEST($1::VARCHAR[]))',
        [row],
      );
      const nodeRows = nodesReader.getRowObjects() as CodeNode[];
      const byId = new Map(nodeRows.map(node => [node.id, node]));
      const edgesReader = await connection.runAndReadAll(
        "SELECT from_id, to_id, kind, confidence, file, line FROM structure_edges WHERE kind = 'calls' AND from_id IN (SELECT UNNEST($1::VARCHAR[]))",
        [row],
      );
      const edgeRows = edgesReader.getRowObjects() as Array<Record<string, unknown>>;
      const edges = row.slice(0, -1)
        .map((from, i) => edgeRows.find(edge => edge.from_id === from && edge.to_id === row[i + 1]))
        .filter(Boolean)
        .map(edge => ({
          from: String(edge!.from_id),
          to: String(edge!.to_id),
          kind: 'calls' as const,
          confidence: edge!.confidence as 'exact' | 'inferred',
          file: edge!.file == null ? undefined : String(edge!.file),
          line: edge!.line == null ? undefined : Number(edge!.line),
        }));
      return { nodes: row.map(id => byId.get(id)).filter((node): node is CodeNode => Boolean(node)), edges };
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
      return (await connection.runAndReadAll(sql, [nodeId])).getRowObjects() as CodeNode[];
    } finally {
      connection.disconnectSync();
    }
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, char => '\\' + char);
}
