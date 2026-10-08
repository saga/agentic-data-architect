import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';
import type {
  CodeEdge,
  CodeNode,
  CodeNodeKind,
  CodeStructureIndex,
  CodeStructureProvider,
  StructurePath,
  StructureQuery,
} from './types.js';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.code-structure']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function nodeId(file: string, kind: CodeNodeKind, name: string, ordinal: number): string {
  // ID 不能包含行号/字符位置：源码前面插入一行时，实体本身没有变化，ID 也必须保持不变。
  return [file, kind, name, ordinal].join('#');
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function scriptKind(file: string): ts.ScriptKind {
  switch (path.extname(file).toLowerCase()) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': return ts.ScriptKind.JS;
    case '.mjs': return ts.ScriptKind.JS;
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.push(absolute);
      }
    }
  }
  await visit(root);
  return result.sort();
}

function addNode(nodes: CodeNode[], map: Map<string, CodeNode>, node: CodeNode): void {
  nodes.push(node);
  map.set(node.id, node);
}

function declarationName(node: ts.Declaration): string | undefined {
  const named = node as ts.NamedDeclaration;
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

/**
 * 第一阶段只解析 TS/JS。
 *
 * 这里故意采用“确定性 AST + 保守解析”：无法唯一解析的调用关系不强行
 * 猜测。对于架构调查，少量可复核的 exact relation 比大量错误 relation 更有价值。
 */
export class TypeScriptCodeStructureProvider implements CodeStructureProvider {
  private index: CodeStructureIndex = {
    version: 1,
    root: '',
    generatedAt: '',
    files: [],
    nodes: [],
    edges: [],
  };

  private readonly nodesById = new Map<string, CodeNode>();
  private readonly edges: CodeEdge[] = [];

  public constructor(
    private readonly rootDirectory: string,
    private readonly outputFile = path.join(rootDirectory, '.code-structure', 'index.json'),
  ) {}

  public async build(): Promise<CodeStructureIndex> {
    // build 可以在同一个 provider 实例上重复执行；先清掉旧节点，避免旧快照污染新查询。
    this.nodesById.clear();
    const root = path.resolve(this.rootDirectory);
    const files = await sourceFiles(root);
    const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');

    const sourceByAbsolute = new Map<string, ts.SourceFile>();
    const fileNodeByPath = new Map<string, CodeNode>();
    const symbolByName = new Map<string, CodeNode[]>();
    const declarationByStart = new Map<string, CodeNode>();
    const declarationOrdinal = new Map<string, number>();
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];

    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      const rel = relative(file);
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
      sourceByAbsolute.set(file, source);

      const fileNode: CodeNode = {
        id: nodeId(rel, 'file', rel, 0),
        kind: 'file',
        name: rel,
        file: rel,
        line: 1,
      };
      fileNodeByPath.set(file, fileNode);
      addNode(nodes, this.nodesById, fileNode);

      const visit = (node: ts.Node, owner?: CodeNode): void => {
        let currentOwner = owner;
        if (
          ts.isClassDeclaration(node)
          || ts.isInterfaceDeclaration(node)
          || ts.isTypeAliasDeclaration(node)
          || ts.isFunctionDeclaration(node)
          || ts.isMethodDeclaration(node)
        ) {
          const name = declarationName(node);
          if (name) {
            const kind: CodeNodeKind = ts.isClassDeclaration(node)
              ? 'class'
              : ts.isInterfaceDeclaration(node)
                ? 'interface'
                : ts.isTypeAliasDeclaration(node)
                  ? 'type'
                  : 'function';
            const ordinalKey = `${kind}\u0000${name}`;
            const ordinal = declarationOrdinal.get(ordinalKey) ?? 0;
            declarationOrdinal.set(ordinalKey, ordinal + 1);
            const symbol: CodeNode = {
              id: nodeId(rel, kind, name, ordinal),
              kind,
              name,
              file: rel,
              line: lineOf(source, node.getStart(source)),
            };
            addNode(nodes, this.nodesById, symbol);
            declarationByStart.set(`${rel}:${node.getStart(source)}`, symbol);
            const list = symbolByName.get(name) ?? [];
            list.push(symbol);
            symbolByName.set(name, list);
            edges.push({
              from: fileNode.id,
              to: symbol.id,
              kind: 'defines',
              confidence: 'exact',
              file: rel,
              line: symbol.line,
            });
            if (owner) {
              edges.push({
                from: owner.id,
                to: symbol.id,
                kind: 'defines',
                confidence: 'exact',
                file: rel,
                line: symbol.line,
              });
            }
            currentOwner = symbol;
          }
        }
        ts.forEachChild(node, child => visit(child, currentOwner));
      };
      visit(source);

      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const module = statement.moduleSpecifier;
        if (!ts.isStringLiteral(module)) continue;
        const resolved = ts.resolveModuleName(
          module.text,
          file,
          { moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.Latest },
          ts.sys,
        ).resolvedModule?.resolvedFileName;
        if (!resolved) continue;
        const target = fileNodeByPath.get(path.resolve(resolved));
        if (!target) continue;
        edges.push({
          from: fileNode.id,
          to: target.id,
          kind: 'imports',
          confidence: 'exact',
          file: rel,
          line: lineOf(source, statement.getStart(source)),
        });
      }
    }

    // 第二遍解析调用和保守 references。只有名字唯一时才建立 exact relation。
    for (const [absolute, source] of sourceByAbsolute) {
      const rel = relative(absolute);
      const fileNode = fileNodeByPath.get(absolute);
      if (!fileNode) continue;

      const resolveUnique = (name: string): CodeNode | undefined => {
        const candidates = symbolByName.get(name) ?? [];
        return candidates.length === 1 ? candidates[0] : undefined;
      };

      const visit = (node: ts.Node, owner?: CodeNode): void => {
        let currentOwner = owner;
        const matching = declarationByStart.get(`${rel}:${node.getStart(source)}`);
        if (matching) currentOwner = matching;

        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          const name = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : undefined;
          const target = name ? resolveUnique(name) : undefined;
          if (target && currentOwner) {
            edges.push({
              from: currentOwner.id,
              to: target.id,
              kind: 'calls',
              confidence: 'exact',
              file: rel,
              line: lineOf(source, node.getStart(source)),
            });
          }
        } else if (ts.isIdentifier(node) && currentOwner) {
          const target = resolveUnique(node.text);
          if (
            target
            && target.id !== currentOwner.id
            && target.file !== rel
            && !ts.isImportDeclaration(node.parent)
            && !ts.isExportSpecifier(node.parent)
          ) {
            edges.push({
              from: currentOwner.id,
              to: target.id,
              kind: 'references',
              confidence: 'inferred',
              file: rel,
              line: lineOf(source, node.getStart(source)),
            });
          }
        }
        ts.forEachChild(node, child => visit(child, currentOwner));
      };
      visit(source, fileNode);
    }

    const hashes = await Promise.all(files.map(async file => ({
      path: relative(file),
      hash: createHash('sha256').update(await fs.readFile(file)).digest('hex'),
      parser: 'typescript-compiler',
    })));

    this.edges.splice(0, this.edges.length, ...edges);
    this.index = {
      version: 1,
      root,
      generatedAt: new Date().toISOString(),
      files: hashes,
      nodes,
      edges: dedupeEdges(edges),
    };

    await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
    await fs.writeFile(this.outputFile, JSON.stringify(this.index, null, 2) + '\n', 'utf8');
    return this.index;
  }

  public find(query: StructureQuery): CodeNode[] {
    const text = query.text?.toLowerCase();
    const result = this.index.nodes.filter(node =>
      (!text || node.name.toLowerCase().includes(text) || node.file.toLowerCase().includes(text))
      && (!query.kind || node.kind === query.kind)
      && (!query.file || node.file === query.file || node.file.startsWith(query.file + '/')),
    );
    return result.slice(0, query.limit ?? 100);
  }

  public callers(nodeId: string): CodeNode[] {
    const ids = new Set(this.index.edges.filter(edge => edge.kind === 'calls' && edge.to === nodeId).map(edge => edge.from));
    return [...ids].map(id => this.nodesById.get(id)).filter((node): node is CodeNode => Boolean(node));
  }

  public callees(nodeId: string): CodeNode[] {
    const ids = new Set(this.index.edges.filter(edge => edge.kind === 'calls' && edge.from === nodeId).map(edge => edge.to));
    return [...ids].map(id => this.nodesById.get(id)).filter((node): node is CodeNode => Boolean(node));
  }

  public trace(fromNodeId: string, toNodeId: string, maxDepth = 8): StructurePath | undefined {
    if (!this.nodesById.has(fromNodeId) || !this.nodesById.has(toNodeId)) return undefined;
    const queue: Array<{ id: string; path: string[] }> = [{ id: fromNodeId, path: [fromNodeId] }];
    const visited = new Set([fromNodeId]);

    while (queue.length) {
      const current = queue.shift()!;
      if (current.id === toNodeId) {
        const pathEdges = current.path.slice(0, -1).map((from, index) => {
          const to = current.path[index + 1];
          return this.index.edges.find(edge => edge.kind === 'calls' && edge.from === from && edge.to === to);
        }).filter((edge): edge is CodeEdge => Boolean(edge));
        return {
          nodes: current.path.map(id => this.nodesById.get(id)).filter((node): node is CodeNode => Boolean(node)),
          edges: pathEdges,
        };
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

  public getIndex(): CodeStructureIndex {
    return this.index;
  }

  /** 从已经生成的快照装载索引；查询阶段不会再次扫描源码。 */
  public loadIndex(index: CodeStructureIndex): void {
    this.index = index;
    this.nodesById.clear();
    for (const node of index.nodes) this.nodesById.set(node.id, node);
  }
}

function dedupeEdges(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = [edge.from, edge.to, edge.kind, edge.line ?? 0].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
