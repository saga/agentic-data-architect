import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Parser as SqlParser } from 'node-sql-parser';

// node-sql-parser is CommonJS. Node 22 does not synthesize a named ESM export
// for Parser, so load the CJS package through createRequire for consistent behavior.
const require = createRequire(import.meta.url);
const { Parser } = require('node-sql-parser') as { Parser: new () => SqlParser };
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
  const node: CodeNode = {
    id: nodeId(file, kind, name, ordinal),
    kind,
    name,
    file,
    ...(line !== undefined ? { line } : {}),
  };
  nodes.push(node);
  map.set(node.id, node);
  return node;
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
    const parseOptions = { database: this.database as any, parseOptions: { includeLocations: true } };
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
        const parsed = parser.astify(text, parseOptions) as any;
        statements = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // 不把无法解析的 SQL 猜成结构事实；文件仍然保留在 snapshot 中。
        continue;
      }

      // Prefer metadata for each statement, but keep a file-level result as a fallback.
      // A successfully parsed SQL statement should not disappear from the structural snapshot
      // just because this parser version returns an unexpected per-statement metadata shape.
      let fileTableEntries: string[] = [];
      let fileColumnEntries: string[] = [];
      try {
        fileTableEntries = parser.tableList(text, parseOptions) ?? [];
        fileColumnEntries = parser.columnList(text, parseOptions) ?? [];
      } catch (error) {
        console.warn('[sql-structure] Could not extract file-level metadata.', {
          file: rel,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      for (let index = 0; index < statements.length; index++) {
        const statement = statements[index];
        let tableAccesses: Array<{ operation: string; name: string }> = [];
        let columns: string[] = [];
        try {
          // The location range keeps INSERT...SELECT source tables attached to the same
          // statement as its target; sqlify is used when the parser omitted source locations.
          const start = statement?.loc?.start?.offset;
          const end = statement?.loc?.end?.offset;
          const statementSql = Number.isInteger(start) && Number.isInteger(end) && end > start
            ? text.slice(start, end)
            : parser.sqlify(statement, parseOptions);
          const tableEntries = parser.tableList(statementSql, parseOptions) ?? [];
          const columnEntries = parser.columnList(statementSql, parseOptions) ?? [];
          tableAccesses = tableEntries
            .map((entry: string) => ({
              operation: entry.split('::')[0]?.toLowerCase() ?? '',
              name: qualifiedTable(entry),
            }))
            .filter((entry: { operation: string; name: string }) => Boolean(entry.name));
          columns = columnEntries
            .map((entry: string) => entry.split('::').slice(1).filter((part: string) => part && part !== 'null').join('.'))
            .filter(Boolean);
        } catch (error) {
          // This is a fallback, not a hard gate: the file AST was already parsed, so retain
          // best-effort table/column facts and leave a diagnostic instead of failing the build.
          const operation = String(statement?.type ?? '').toLowerCase();
          const fallbackEntries = fileTableEntries.filter((entry) => {
            const kind = entry.split('::')[0]?.toLowerCase() ?? '';
            return kind === operation || (operation === 'insert' && kind === 'select');
          });
          tableAccesses = fallbackEntries
            .map((entry) => ({
              operation: entry.split('::')[0]?.toLowerCase() ?? '',
              name: qualifiedTable(entry),
            }))
            .filter((entry) => Boolean(entry.name));
          columns = fileColumnEntries
            .map((entry) => entry.split('::').slice(1).filter((part) => part && part !== 'null').join('.'))
            .filter(Boolean);
          console.warn('[sql-structure] Used file-level SQL metadata fallback.', {
            file: rel,
            statement: index + 1,
            type: operation,
            reason: error instanceof Error ? error.message : String(error),
          });
        }

        const statementName = String(statement?.type ?? 'statement') + ':' + index;
        const stmtNode = add(nodes, new Map(), rel, 'statement', statementName, ordinals, 1);
        edges.push({ from: file.id, to: stmtNode.id, kind: 'contains', confidence: 'exact', file: rel, line: 1 });

        const tableNames = [...new Set(tableAccesses.map((entry) => entry.name))];
        const tableNodesByName = new Map<string, CodeNode>();
        for (const tableName of tableNames) {
          const key = tableName.toLowerCase();
          let tableNode = objectNodes.get(key);
          if (!tableNode) {
            const kind: CodeNode['kind'] = /^(view|views)[:.]/i.test(tableName) ? 'view' : 'table';
            tableNode = add(nodes, new Map(), rel, kind, tableName, ordinals, 1);
            objectNodes.set(key, tableNode);
          }
          tableNodesByName.set(tableName, tableNode);
        }

        for (const access of tableAccesses) {
          const table = tableNodesByName.get(access.name);
          if (!table) continue;
          const write = ['insert', 'update', 'delete'].includes(access.operation);
          edges.push({ from: stmtNode.id, to: table.id, kind: write ? 'writes' : 'reads', confidence: 'exact', file: rel, line: 1 });
        }
        const joinedTables = [...new Set(tableAccesses
          .filter((entry) => entry.operation === 'select')
          .map((entry) => entry.name))]
          .map((name) => tableNodesByName.get(name))
          .filter((node): node is CodeNode => Boolean(node));
        if (String(statement?.type).toLowerCase() === 'select' && joinedTables.length > 1) {
          for (let i = 1; i < joinedTables.length; i++) {
            edges.push({ from: joinedTables[0]!.id, to: joinedTables[i]!.id, kind: 'joins', confidence: 'inferred', file: rel, line: 1 });
          }
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
