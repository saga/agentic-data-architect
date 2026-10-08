import path from 'node:path';
import { CodeStructureIndexProvider } from '../src/structure/code-structure-index-provider.js';

/**
 * 构建轻量 Code Structure Index。
 *
 * 这是一个显式开发/调查工具，不会自动改变 Investigation workflow。
 * 生成的快照位于目标 repository 的 .code-structure/index.json。
 */
const root = path.resolve(process.argv[2] ?? '.');
const provider = new CodeStructureIndexProvider(root);
const index = await provider.build();

console.log(JSON.stringify({
  root: index.root,
  files: index.files.length,
  nodes: index.nodes.length,
  edges: index.edges.length,
  output: path.join(index.root, '.code-structure', 'index.json'),
  database: path.join(index.root, '.code-structure', 'structure.duckdb'),
}, null, 2));
