import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import Python from 'tree-sitter-python';
import CSharp from 'tree-sitter-c-sharp';
import type { CodeEdge, CodeNode, CodeNodeKind, CodeStructureIndex, CodeStructureProvider, StructurePath, StructureQuery } from './types.js';

type Language = 'java' | 'python' | 'csharp';
type Grammar = { extensions: string[]; language: Language; grammar: unknown };

const GRAMMARS: Grammar[] = [
  { language: 'java', extensions: ['.java'], grammar: Java },
  { language: 'python', extensions: ['.py'], grammar: Python },
  { language: 'csharp', extensions: ['.cs'], grammar: CSharp },
];

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.code-structure']);

function id(file: string, kind: CodeNodeKind, name: string, ordinal: number): string {
  return [file, kind, name, ordinal].join('#');
}

function line(node: any): number { return node.startPosition.row + 1; }

function languageFor(file: string): Grammar | undefined {
  const ext = path.extname(file).toLowerCase();
  return GRAMMARS.find(item => item.extensions.includes(ext));
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && languageFor(absolute)) result.push(absolute);
    }
  }
  await visit(root);
  return result.sort();
}

function children(node: any): any[] { return node.namedChildren ?? []; }

function firstField(node: any, field: string): any | undefined {
  return node.childForFieldName?.(field) ?? undefined;
}

function namedFieldText(node: any, field: string): string | undefined {
  const child = firstField(node, field);
  return child?.text;
}

function declaration(node: any, language: Language): { kind: CodeNodeKind; name: string } | undefined {
  const t = node.type;
  const name = namedFieldText(node, 'name');
  if (!name) return undefined;

  if (language === 'java') {
    if (['class_declaration', 'enum_declaration', 'record_declaration'].includes(t)) return { kind: 'class', name };
    if (t === 'interface_declaration') return { kind: 'interface', name };
    if (t === 'method_declaration') return { kind: 'method', name };
    if (t === 'constructor_declaration') return { kind: 'method', name };
  }
  if (language === 'python') {
    if (t === 'class_definition') return { kind: 'class', name };
    if (t === 'function_definition') return { kind: 'function', name };
  }
  if (language === 'csharp') {
    if (['class_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration'].includes(t)) return { kind: 'class', name };
    if (t === 'interface_declaration') return { kind: 'interface', name };
    if (['method_declaration', 'constructor_declaration', 'local_function_statement'].includes(t)) return { kind: 'method', name };
  }
  return undefined;
}

function callName(node: any): string | undefined {
  if (!['method_invocation', 'invocation_expression', 'call', 'call_expression'].includes(node.type)) return undefined;
  const functionNode = firstField(node, 'name') ?? firstField(node, 'function') ?? firstField(node, 'method');
  if (functionNode?.text) return functionNode.text.split('.').pop();
  const text = node.text ?? '';
  const match = text.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  return match?.[1];
}

export class TreeSitterCodeStructureProvider implements CodeStructureProvider {
  private index: CodeStructureIndex = { version: 1, root: '', generatedAt: '', files: [], nodes: [], edges: [] };
  private readonly nodesById = new Map<string, CodeNode>();

  constructor(
    private readonly rootDirectory: string,
    private readonly outputFile = path.join(rootDirectory, '.code-structure', 'index.json'),
  ) {}

  async build(): Promise<CodeStructureIndex> {
    const root = path.resolve(this.rootDirectory);
    const sourceFiles = await filesUnder(root);
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const symbols = new Map<string, CodeNode[]>();
    const declarationByStart = new Map<string, CodeNode>();
    const fileNodeByPath = new Map<string, CodeNode>();

    for (const absolute of sourceFiles) {
      const grammar = languageFor(absolute)!;
      const source = await fs.readFile(absolute, 'utf8');
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      const parser = new Parser();
      parser.setLanguage(grammar.grammar as any);
      const tree = parser.parse(source);
      const fileNode: CodeNode = { id: id(rel, 'file', rel, 0), kind: 'file', name: rel, file: rel, line: 1 };
      nodes.push(fileNode);
      fileNodeByPath.set(rel, fileNode);

      const ordinals = new Map<string, number>();
      const visit = (node: any, owner?: CodeNode): void => {
        let currentOwner = owner;
        const d = declaration(node, grammar.language);
        if (d) {
          const key = `${d.kind}\0${d.name}`;
          const ordinal = ordinals.get(key) ?? 0;
          ordinals.set(key, ordinal + 1);
          const symbol: CodeNode = { id: id(rel, d.kind, d.name, ordinal), kind: d.kind, name: d.name, file: rel, line: line(node) };
          nodes.push(symbol);
          declarationByStart.set(`${rel}:${node.startIndex}`, symbol);
          const list = symbols.get(d.name) ?? [];
          list.push(symbol);
          symbols.set(d.name, list);
          edges.push({ from: fileNode.id, to: symbol.id, kind: 'defines', confidence: 'exact', file: rel, line: symbol.line });
          if (owner) edges.push({ from: owner.id, to: symbol.id, kind: 'defines', confidence: 'exact', file: rel, line: symbol.line });
          currentOwner = symbol;
        }
        for (const child of children(node)) visit(child, currentOwner);
      };
      visit(tree.rootNode);

      const visitCalls = (node: any, owner?: CodeNode): void => {
        let currentOwner = declarationByStart.get(`${rel}:${node.startIndex}`) ?? owner;
        const name = callName(node);
        if (name && currentOwner) {
          const candidates = symbols.get(name) ?? [];
          if (candidates.length === 1) edges.push({ from: currentOwner.id, to: candidates[0].id, kind: 'calls', confidence: 'exact', file: rel, line: line(node) });
        }
        for (const child of children(node)) visitCalls(child, currentOwner);
      };
      visitCalls(tree.rootNode, fileNode);
    }

    const files = await Promise.all(sourceFiles.map(async absolute => ({
      path: path.relative(root, absolute).split(path.sep).join('/'),
      hash: createHash('sha256').update(await fs.readFile(absolute)).digest('hex'),
      parser: languageFor(absolute)!.language === 'csharp' ? 'tree-sitter-c-sharp' : `tree-sitter-${languageFor(absolute)!.language}`,
    })));

    this.index = { version: 1, root, generatedAt: new Date().toISOString(), files, nodes, edges: dedupe(edges) };
    this.nodesById.clear();
    for (const node of nodes) this.nodesById.set(node.id, node);
    await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
    await fs.writeFile(this.outputFile, JSON.stringify(this.index, null, 2) + '\n', 'utf8');
    return this.index;
  }

  find(query: StructureQuery): CodeNode[] {
    const text = query.text?.toLowerCase();
    return this.index.nodes.filter(n =>
      (!text || n.name.toLowerCase().includes(text) || n.file.toLowerCase().includes(text)) &&
      (!query.kind || n.kind === query.kind) &&
      (!query.file || n.file === query.file || n.file.startsWith(query.file + '/'))
    ).slice(0, query.limit ?? 100);
  }
  callers(nodeId: string): CodeNode[] {
    const ids = new Set(this.index.edges.filter(e => e.kind === 'calls' && e.to === nodeId).map(e => e.from));
    return [...ids].map(id => this.nodesById.get(id)).filter(Boolean) as CodeNode[];
  }
  callees(nodeId: string): CodeNode[] {
    const ids = new Set(this.index.edges.filter(e => e.kind === 'calls' && e.from === nodeId).map(e => e.to));
    return [...ids].map(id => this.nodesById.get(id)).filter(Boolean) as CodeNode[];
  }
  trace(fromNodeId: string, toNodeId: string, maxDepth = 8): StructurePath | undefined {
    const queue = [{ id: fromNodeId, path: [fromNodeId] }];
    const seen = new Set([fromNodeId]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current.id === toNodeId) {
        const edges = current.path.slice(0, -1).map((from, i) => this.index.edges.find(e => e.kind === 'calls' && e.from === from && e.to === current.path[i + 1])).filter(Boolean) as CodeEdge[];
        return { nodes: current.path.map(i => this.nodesById.get(i)).filter(Boolean) as CodeNode[], edges };
      }
      if (current.path.length - 1 >= maxDepth) continue;
      for (const edge of this.index.edges) {
        if (edge.kind !== 'calls' || edge.from !== current.id || seen.has(edge.to)) continue;
        seen.add(edge.to); queue.push({ id: edge.to, path: [...current.path, edge.to] });
      }
    }
    return undefined;
  }
  loadIndex(index: CodeStructureIndex): void {
    this.index = index;
    this.nodesById.clear();
    for (const node of index.nodes) this.nodesById.set(node.id, node);
  }
}

function dedupe(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = [e.from, e.to, e.kind, e.line ?? 0].join('|');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
