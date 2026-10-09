import path from 'node:path';
import fs from 'node:fs/promises';
import { TypeScriptCodeStructureProvider } from './typescript-provider.js';
import { TreeSitterCodeStructureProvider } from './tree-sitter-provider.js';
import { SqlCodeStructureProvider } from './sql-provider.js';
import { CodeStructureDuckDBProjector, DEFAULT_STRUCTURE_DATABASE } from './duckdb-projector.js';
import type { CodeEdge, CodeNode, CodeStructureIndex, CodeStructureProvider, StructurePath, StructureQuery } from './types.js';

export class CodeStructureIndexProvider implements CodeStructureProvider {
  private index: CodeStructureIndex = { version: 1, root: '', generatedAt: '', files: [], nodes: [], edges: [] };

  constructor(
    private readonly rootDirectory: string,
    private readonly outputFile = path.join(rootDirectory, '.code-structure', 'index.json'),
    private readonly databaseFile = path.join(rootDirectory, DEFAULT_STRUCTURE_DATABASE),
  ) {}

  async build(): Promise<CodeStructureIndex> {
    const root = path.resolve(this.rootDirectory);
    const partsDir = path.join(root, '.code-structure', '.parts');
    const providers = [
      new TypeScriptCodeStructureProvider(root, path.join(partsDir, 'typescript.json')),
      new TreeSitterCodeStructureProvider(root, path.join(partsDir, 'tree-sitter.json')),
      new SqlCodeStructureProvider(root, path.join(partsDir, 'sql.json')),
    ];

    const indexes: CodeStructureIndex[] = [];
    for (const provider of providers) indexes.push(await provider.build());

    const files = indexes.flatMap(index => index.files);
    const nodes = indexes.flatMap(index => index.nodes);
    const edges = dedupe(indexes.flatMap(index => index.edges));

    this.index = {
      version: 1,
      root,
      generatedAt: new Date().toISOString(),
      files: dedupeFiles(files),
      nodes,
      edges,
    };
    await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
    const temporaryOutput = `${this.outputFile}.tmp-${process.pid}`;
    try {
      await fs.writeFile(temporaryOutput, JSON.stringify(this.index, null, 2) + '\n', 'utf8');
      await fs.rename(temporaryOutput, this.outputFile);
    } catch (error) {
      await fs.rm(temporaryOutput, { force: true }).catch(() => undefined);
      throw error;
    }

    // DuckDB is a disposable analytical projection. index.json remains authoritative.
    // If projection refresh fails, make the partial-success boundary explicit: callers
    // must not assume the DuckDB copy is current just because the canonical JSON was saved.
    try {
      await new CodeStructureDuckDBProjector(root, this.databaseFile).project(this.index);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Canonical structure index was saved to "${this.outputFile}", but DuckDB projection "${this.databaseFile}" failed: ${detail}. Rebuild the structure index to retry projection.`,
        { cause: error },
      );
    }
    return this.index;
  }

  find(query: StructureQuery): CodeNode[] {
    const text = query.text?.toLowerCase();
    return this.index.nodes.filter(node =>
      (!text || node.name.toLowerCase().includes(text) || node.file.toLowerCase().includes(text)) &&
      (!query.kind || node.kind === query.kind) &&
      (!query.file || node.file === query.file || node.file.startsWith(query.file + '/'))
    ).slice(0, query.limit ?? 100);
  }

  callers(nodeId: string): CodeNode[] {
    return this.related(nodeId, 'calls', 'to');
  }

  callees(nodeId: string): CodeNode[] {
    return this.related(nodeId, 'calls', 'from');
  }

  private related(nodeId: string, kind: CodeEdge['kind'], side: 'from' | 'to'): CodeNode[] {
    const ids = new Set(this.index.edges.filter(edge => edge.kind === kind && edge[side] === nodeId)
      .map(edge => side === 'from' ? edge.to : edge.from));
    return [...ids].map(id => this.index.nodes.find(node => node.id === id)).filter((node): node is CodeNode => Boolean(node));
  }

  trace(fromNodeId: string, toNodeId: string, maxDepth = 8): StructurePath | undefined {
    const byId = new Map(this.index.nodes.map(node => [node.id, node]));
    if (!byId.has(fromNodeId) || !byId.has(toNodeId)) return undefined;
    const queue: Array<{ id: string; path: string[] }> = [{ id: fromNodeId, path: [fromNodeId] }];
    const visited = new Set([fromNodeId]);

    while (queue.length) {
      const current = queue.shift()!;
      if (current.id === toNodeId) {
        const edges = current.path.slice(0, -1).map((from, i) =>
          this.index.edges.find(edge => edge.kind === 'calls' && edge.from === from && edge.to === current.path[i + 1])
        ).filter((edge): edge is CodeEdge => Boolean(edge));
        return { nodes: current.path.map(id => byId.get(id)).filter((node): node is CodeNode => Boolean(node)), edges };
      }
      if (current.path.length - 1 >= maxDepth) continue;
      for (const edge of this.index.edges) {
        if (edge.kind !== 'calls' || edge.from !== current.id || visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push({ id: edge.to, path: [...current.path, edge.to] });
      }
    }
    return undefined;
  }

  loadIndex(index: CodeStructureIndex): void {
    this.index = index;
  }
}

function dedupeFiles(files: CodeStructureIndex['files']): CodeStructureIndex['files'] {
  const seen = new Set<string>();
  return files.filter(file => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function dedupe(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = [edge.from, edge.to, edge.kind, edge.line ?? 0].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
