/**
 * Code Structure Index 的最小稳定模型。
 *
 * 这一层刻意不暴露具体 parser API。上层只依赖结构节点、关系和查询能力，
 * 因此 TypeScript compiler、Tree-sitter、SQL parser 和 artifact extractor
 * 都可以进入同一个 canonical snapshot。
 */
export type CodeNodeKind = 'file' | 'module' | 'package' | 'class' | 'function' | 'method' | 'interface' | 'type' | 'statement' | 'table' | 'view' | 'column' | 'job' | 'pipeline';
export type CodeEdgeKind = 'imports' | 'defines' | 'calls' | 'references' | 'contains' | 'reads' | 'writes' | 'joins' | 'dependsOn';
export type CodeEdgeConfidence = 'exact' | 'inferred';

export interface CodeNode {
  id: string;
  kind: CodeNodeKind;
  name: string;
  file: string;
  line?: number;
}

export interface CodeEdge {
  from: string;
  to: string;
  kind: CodeEdgeKind;
  confidence: CodeEdgeConfidence;
  file?: string;
  line?: number;
}

export interface CodeStructureIndex {
  version: 1;
  root: string;
  generatedAt: string;
  files: Array<{
    path: string;
    hash: string;
    parser: string;
  }>;
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export interface StructureQuery {
  text?: string;
  kind?: CodeNodeKind;
  file?: string;
  limit?: number;
}

export interface StructurePath {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export interface CodeStructureProvider {
  build(): Promise<CodeStructureIndex>;
  find(query: StructureQuery): CodeNode[];
  callers(nodeId: string): CodeNode[];
  callees(nodeId: string): CodeNode[];
  trace(fromNodeId: string, toNodeId: string, maxDepth?: number): StructurePath | undefined;
  loadIndex?(index: CodeStructureIndex): void;
}
