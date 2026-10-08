import fs from 'node:fs/promises';
import path from 'node:path';
import { TypeScriptCodeStructureProvider } from '../src/structure/typescript-provider.js';
import type { CodeStructureIndex } from '../src/structure/types.js';

const [rootArg = '.', operation = 'find', ...args] = process.argv.slice(2);
const root = path.resolve(rootArg);
const indexFile = path.join(root, '.code-structure', 'index.json');

let index: CodeStructureIndex;
try {
  index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as CodeStructureIndex;
} catch {
  index = await new TypeScriptCodeStructureProvider(root).build();
}

const provider = new TypeScriptCodeStructureProvider(root);
await fs.mkdir(path.dirname(indexFile), { recursive: true });
await fs.writeFile(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf8');

// 查询 provider 使用持久化快照，避免每次 query 都重新扫描源码。
const providerIndex = (provider as unknown as { index: CodeStructureIndex }).index;
providerIndex.version = index.version;
providerIndex.root = index.root;
providerIndex.generatedAt = index.generatedAt;
providerIndex.files = index.files;
providerIndex.nodes = index.nodes;
providerIndex.edges = index.edges;
for (const node of index.nodes) {
  (provider as unknown as { nodesById: Map<string, unknown> }).nodesById.set(node.id, node);
}

const output = (() => {
  switch (operation) {
    case 'find':
      return provider.find({ text: args[0], kind: args[1] as never });
    case 'callers':
      return provider.callers(args[0] ?? '');
    case 'callees':
      return provider.callees(args[0] ?? '');
    case 'trace':
      return provider.trace(args[0] ?? '', args[1] ?? '', Number(args[2] ?? 8));
    default:
      throw new Error('operation must be find|callers|callees|trace');
  }
})();

console.log(JSON.stringify(output, null, 2));
