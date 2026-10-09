import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import TreeSitter from '@vscode/tree-sitter-wasm';
import type * as TreeSitterTypes from '@vscode/tree-sitter-wasm';
import type { CodeEdge, CodeNode, CodeNodeKind, CodeStructureIndex, CodeStructureProvider, StructurePath, StructureQuery } from './types.js';

type Language = 'java' | 'python' | 'csharp';
type Grammar = { extensions: string[]; language: Language; wasmFile: string; packageName?: string };

const GRAMMARS: Grammar[] = [
  { language: 'java', extensions: ['.java'], wasmFile: 'tree-sitter-java.wasm' },
  { language: 'python', extensions: ['.py'], wasmFile: 'tree-sitter-python.wasm' },
  // @vscode/tree-sitter-wasm@0.3.1 does not publish its C# grammar asset; use the official grammar package.
  { language: 'csharp', extensions: ['.cs'], wasmFile: 'tree-sitter-c_sharp.wasm', packageName: 'tree-sitter-c-sharp' },
];

const require = createRequire(import.meta.url);
let treeSitterInitPromise: Promise<typeof TreeSitter> | undefined;
const languagePromises = new Map<string, Promise<TreeSitterTypes.Language>>();

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

/**
 * 初始化 VS Code 提供的 Tree-sitter WASM runtime。
 *
 * Parser.init() 会修改进程级 WASM 状态，因此整个进程只初始化一次。
 * 多个并发 build 会共享同一个 Promise，不会重复初始化底层运行时。
 */
async function getTreeSitter(): Promise<typeof TreeSitter> {
  treeSitterInitPromise ??= (async () => {
    const moduleRoot = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
    await TreeSitter.Parser.init({
      // npm 包把 tree-sitter.js 和 tree-sitter.wasm 放在同一个目录。
      // 显式指定路径，避免 ESM / tsx 的运行方式影响 Emscripten 的文件定位。
      locateFile: () => path.join(moduleRoot, 'tree-sitter.wasm'),
    });
    return TreeSitter;
  })();
  return treeSitterInitPromise;
}

/**
 * 加载 Java / Python / C# 的预编译 grammar，并按语言缓存。
 *
 * Language.load() 接收完整 WASM 二进制；缓存 Promise 是为了让同一个进程里大量同语言文件
 * 共享一次加载和编译，同时在首次加载失败时允许下一次 build 重试。
 */
async function loadLanguage(grammar: Grammar): Promise<TreeSitterTypes.Language> {
  const cached = languagePromises.get(grammar.language);
  if (cached) return cached;

  const promise = (async () => {
    const TreeSitter = await getTreeSitter();
    // Runtime initialization always comes from VS Code's package, but grammar assets must
    // be resolved from the package that actually publishes each language binary.
    const grammarRoot = grammar.packageName
      ? path.dirname(require.resolve(grammar.packageName + '/package.json'))
      : path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
    const bytes = await fs.readFile(path.join(grammarRoot, grammar.wasmFile));
    return TreeSitter.Language.load(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
  })();

  languagePromises.set(grammar.language, promise);
  try {
    return await promise;
  } catch (error) {
    languagePromises.delete(grammar.language);
    throw error;
  }
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

/**
 * Java / Python / C# 的结构解析 Provider。
 *
 * Tree-sitter 只负责把源码解析成 AST；这里负责把 AST 转成项目自己的 Code Structure Index。
 * 上层只依赖 CodeStructureProvider，不会看到 Tree-sitter 的 Node / Parser 对象，也不会直接产生 Evidence。
 *
 * Parser 和 Tree 都占用 WASM heap，所以每个文件处理结束时必须释放，异常路径也不能遗漏。
 */
export class TreeSitterCodeStructureProvider implements CodeStructureProvider {
  private index: CodeStructureIndex = { version: 1, root: '', generatedAt: '', files: [], nodes: [], edges: [] };
  private readonly nodesById = new Map<string, CodeNode>();

  constructor(
    private readonly rootDirectory: string,
    private readonly outputFile = path.join(rootDirectory, '.code-structure', 'index.json'),
  ) {}

  /**
   * 从当前目录重新建立完整结构索引。
   *
   * 每次 build 都以当前源码为唯一输入，重新产生 canonical snapshot；不复用旧节点/边，
   * 这样文件被删除后不会留下幽灵节点，结果也更容易复现。
   */
  async build(): Promise<CodeStructureIndex> {
    const root = path.resolve(this.rootDirectory);
    const sourceFiles = await filesUnder(root);
    const nodes: CodeNode[] = [];
    const edges: CodeEdge[] = [];
    const symbols = new Map<string, CodeNode[]>();
    const declarationByStart = new Map<string, CodeNode>();
    const fileRecords: CodeStructureIndex['files'] = [];

    for (const absolute of sourceFiles) {
      const grammar = languageFor(absolute)!;
      const sourceBytes = await fs.readFile(absolute);
      const source = sourceBytes.toString('utf8');
      const rel = path.relative(root, absolute).split(path.sep).join('/');

      // The published tree-sitter-c-sharp npm package is a native binding, not a WASM
      // grammar. Keep C# files useful with a conservative declaration-only fallback rather
      // than trying to load a native grammar binary as WASM.
      if (grammar.language === 'csharp') {
        const fileNode: CodeNode = { id: id(rel, 'file', rel, 0), kind: 'file', name: rel, file: rel, line: 1 };
        nodes.push(fileNode);
        const ordinals = new Map<string, number>();
        const declarations: Array<{ kind: CodeNodeKind; name: string; line: number }> = [];
        const lines = source.split(/\\r?\\n/);
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i]!;
          const typeMatch = lineText.match(/\\b(class|struct|record|interface|enum)\\s+(\\w+)/);
          if (typeMatch) {
            declarations.push({
              kind: typeMatch[1] === 'interface' ? 'interface' : 'class',
              name: typeMatch[2]!,
              line: i + 1,
            });
            continue;
          }
          const methodMatch = lineText.match(/^\\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|new|partial|extern|unsafe|readonly)\\s+)*(?:[\\w<>,?.\\[\\]]+\\s+)+(\\w+)\\s*\\([^;]*\\)\\s*(?:\\{|=>)/);
          if (methodMatch && !['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock'].includes(methodMatch[1]!)) {
            declarations.push({ kind: 'method', name: methodMatch[1]!, line: i + 1 });
          }
        }
        for (const declaration of declarations) {
          const key = declaration.kind + '\\0' + declaration.name;
          const ordinal = ordinals.get(key) ?? 0;
          ordinals.set(key, ordinal + 1);
          const symbol: CodeNode = {
            id: id(rel, declaration.kind, declaration.name, ordinal),
            kind: declaration.kind,
            name: declaration.name,
            file: rel,
            line: declaration.line,
          };
          nodes.push(symbol);
          const list = symbols.get(symbol.name) ?? [];
          list.push(symbol);
          symbols.set(symbol.name, list);
          edges.push({ from: fileNode.id, to: symbol.id, kind: 'defines', confidence: 'inferred', file: rel, line: declaration.line });
        }
        fileRecords.push({
          path: rel,
          hash: createHash('sha256').update(sourceBytes).digest('hex'),
          parser: 'csharp-declaration-fallback',
        });
        continue;
      }

      const language = await loadLanguage(grammar);

      // Parser / Tree 都是当前文件的短生命周期 WASM 资源；无论解析还是遍历失败，都必须释放。
      const parser = new TreeSitter.Parser();
      try {
        parser.setLanguage(language);
        const tree = parser.parse(source);
        if (!tree) throw new Error('Tree-sitter 没有返回语法树：' + rel);

        try {
          const fileNode: CodeNode = { id: id(rel, 'file', rel, 0), kind: 'file', name: rel, file: rel, line: 1 };
          nodes.push(fileNode);

          const ordinals = new Map<string, number>();
          const visit = (node: any, owner?: CodeNode): void => {
            let currentOwner = owner;
            const d = declaration(node, grammar.language);
            if (d) {
              const key = `${d.kind}\0${d.name}`;
              const ordinal = ordinals.get(key) ?? 0;
              ordinals.set(key, ordinal + 1);
              const declarationLine = line(node);
              const symbol: CodeNode = { id: id(rel, d.kind, d.name, ordinal), kind: d.kind, name: d.name, file: rel, line: declarationLine };
              nodes.push(symbol);
              declarationByStart.set(`${rel}:${node.startIndex}`, symbol);
              const list = symbols.get(d.name) ?? [];
              list.push(symbol);
              symbols.set(d.name, list);
              edges.push({ from: fileNode.id, to: symbol.id, kind: 'defines', confidence: 'exact', file: rel, line: declarationLine });
              if (owner) edges.push({ from: owner.id, to: symbol.id, kind: 'defines', confidence: 'exact', file: rel, line: declarationLine });
              currentOwner = symbol;
            }
            for (const child of children(node)) visit(child, currentOwner);
          };
          visit(tree.rootNode);

          const visitCalls = (node: any, owner?: CodeNode): void => {
            const currentOwner = declarationByStart.get(`${rel}:${node.startIndex}`) ?? owner;
            const name = callName(node);
            if (name && currentOwner) {
              const candidates = symbols.get(name) ?? [];
              // 只有候选唯一时才建立 calls edge。重载、同名方法或跨作用域情况不能仅凭文本可靠解析，
              // 宁可漏掉关系，也不能把错误关系写进 canonical index。
              if (candidates.length === 1) {
                edges.push({ from: currentOwner.id, to: candidates[0].id, kind: 'calls', confidence: 'exact', file: rel, line: line(node) });
              }
            }
            for (const child of children(node)) visitCalls(child, currentOwner);
          };
          visitCalls(tree.rootNode, fileNode);
        } finally {
          // Tree 也占用 WASM heap；遍历函数抛异常时仍要释放。
          tree.delete();
        }
      } finally {
        // Parser 同样不是 GC 可以及时替代的资源，必须显式 delete。
        parser.delete();
      }

      fileRecords.push({
        path: rel,
        hash: createHash('sha256').update(sourceBytes).digest('hex'),
        parser: 'tree-sitter-' + grammar.language,
      });
    }

    this.index = { version: 1, root, generatedAt: new Date().toISOString(), files: fileRecords, nodes, edges: dedupe(edges) };
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
