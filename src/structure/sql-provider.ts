import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Parser } from 'node-sql-parser';
import type { CodeEdge, CodeNode, CodeStructureIndex, CodeStructureProvider, StructurePath, StructureQuery } from './types.js';

const SQL_EXTENSIONS = new Set(['.sql', '.ddl', '.dml', '.hql']);
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.code-structure']);

function nodeId(file: string, kind: CodeNode['kind'], name: string, ordinal: number): string {
  return [file, kind, name, ordinal].join('#');
}

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && SQL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(absolute);
    }
  }
  await visit(root);
  return result.sort();
}

function qualifiedTable(value: string): string {
  const parts = value.split('::');
  return parts.slice(1).filter(p => p && p !== 'null').join('.');
}

function add(
  nodes: CodeNode[], map: Map<string, CodeNode>, file: string, kind: CodeNode['kind'], name: string,
  ordinals: Map<string, number>, line?: number,
): CodeNode {
  const key = `${kind}\0${name}`;
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  const node = { id: nodeId(file, kind, name, ordinal), kind, name, file, line };
  nodes.push(node); map.set(node.id, node); return node;
}

export class SqlCodeStructureProvider implements CodeStructureProvider {
  private index: CodeStructureIndex = { version: 1, root: '', generatedAt: '', files: [], nodes: [], edges: [] };
  private readonly nodesById = new Map<string, CodeNode>();

  constructor(
    private readonly rootDirectory: string,
    private readonly outputFile = path.join(rootDirectory, '.code-structure', 'index.json'),
    private readonly database: string = 'mysql',
  ) {}

  async build(): Promise<CodeStructureIndex> {
    const root = path.resolve(this.rootDirectory);
    const files = await sourceFiles(root);
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const fileNodeByPath = new Map<string, CodeNode>();
    const objectNodes = new Map<string, CodeNode>();
    const parser = new Parser();
    const hashes: CodeStructureIndex['files'] = [];

    for (const absolute of files) {
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      const text = await fs.readFile(absolute, 'utf8');
      hashes.push({ path: rel, hash: createHash('sha256').update(text).digest('hex'), parser: 'node-sql-parser' });
      const file = add(nodes, new Map(), rel, 'file', rel, new Map([['file\0' + rel, 1]]), 1);
      fileNodeByPath.set(rel, file);
      const ordinals = new Map<string, number>();
      ordinals.set('file\0' + rel, 1);

      let statements: any[];
      try {
        const parsed = parser.astify(text, { database: this.database as any }) as any;
        statements = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // 不把无法解析的 SQL 猜成结构事实；文件仍然保留在 snapshot 中。
        continue;
      }

      for (let index = 0; index < statements.length; index++) {
        const statement = statements[index];
        const statementName = `${statement?.type ?? 'statement'}:${index}`;
        const stmtNode = add(nodes, new Map(), rel, 'statement', statementName, ordinals, 1);
        edges.push({ from: file.id, to: stmtNode.id, kind: 'contains', confidence: 'exact', file: rel, line: 1 });

        const tables: string[] = Array.isArray(statement?.tableList)
          ? statement.tableList.map((x: string) => qualifiedTable(x)).filter(Boolean)
          : [];
        const columns: string[] = Array.isArray(statement?.columnList)
          ? statement.columnList.map((x: string) => x.split('::').slice(1).filter((p: string) => p && p !== 'null').join('.')).filter(Boolean)
          : [];

        const uniqueTables = [...new Set(tables)];
        const tableNodes: CodeNode[] = [];
        for (const tableName of uniqueTables) {
          const key = tableName.toLowerCase();
          let tableNode = objectNodes.get(key);
          if (!tableNode) {
            const kind: CodeNode['kind'] = /^(view|views)[:.]/i.test(tableName) ? 'view' : 'table';
            tableNode = add(nodes, new Map(), rel, kind, tableName, ordinals, 1);
            objectNodes.set(key, tableNode);
          }
          tableNodes.push(tableNode);
        }

        for (const table of tableNodes) {
          const write = ['insert', 'update', 'delete'].includes(String(statement?.type).toLowerCase());
          edges.push({ from: stmtNode.id, to: table.id, kind: write ? 'writes' : 'reads', confidence: 'exact', file: rel, line: 1 });
        }
        if (tableNodes.length > 1) {
          for (let i = 1; i < tableNodes.length; i++) edges.push({ from: tableNodes[0].id, to: tableNodes[i].id, kind: 'joins', confidence: 'inferred', file: rel, line: 1 });
        }

        for (const columnName of [...new Set(columns)]) {
          const columnNode = add(nodes, new Map(), rel, 'column', columnName, ordinals, 1);
          edges.push({ from: stmtNode.id, to: columnNode.id, kind: 'references', confidence: 'exact', file: rel, line: 1 });
        }
      }
    }

    this.index = { version: 1, root, generatedAt: new Date().toISOString(), files: hashes, nodes, edges: dedupe(edges) };
    this.nodesById.clear(); for (const n of nodes) this.nodesById.set(n.id, n);
    await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
    await fs.writeFile(this.outputFile, JSON.stringify(this.index, null, 2) + '\n', 'utf8');
    return this.index;
  }

  find(query: StructureQuery): CodeNode[] {
    const text = query.text?.toLowerCase();
    return this.index.nodes.filter(n => (!text || n.name.toLowerCase().includes(text)) && (!query.kind || n.kind === query.kind)).slice(0, query.limit ?? 100);
  }
  callers(nodeId: string): CodeNode[] { return this.related(nodeId, 'calls', 'to'); }
  callees(nodeId: string): CodeNode[] { return this.related(nodeId, 'calls', 'from'); }
  private related(nodeId: string, kind: string, side: 'from'|'to'): CodeNode[] {
    const ids = new Set(this.index.edges.filter(e => e.kind === kind && e[side] === nodeId).map(e => side === 'from' ? e.to : e.from));
    return [...ids].map(id => this.nodesById.get(id)).filter(Boolean) as CodeNode[];
  }
  trace(): StructurePath | undefined { return undefined; }
  loadIndex(index: CodeStructureIndex): void { this.index = index; this.nodesById.clear(); for (const n of index.nodes) this.nodesById.set(n.id, n); }
}

function dedupe(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  return edges.filter(e => { const key = [e.from,e.to,e.kind,e.line??0].join('|'); if (seen.has(key)) return false; seen.add(key); return true; });
}
