import fs from 'node:fs/promises';
import path from 'node:path';
import { CodeStructureIndexProvider } from '../src/structure/code-structure-index-provider.js';
import type { CodeStructureIndex } from '../src/structure/types.js';

const [rootArg = '.', operation = 'find', ...args] = process.argv.slice(2);
const root = path.resolve(rootArg);
const indexFile = path.join(root, '.code-structure', 'index.json');

let index: CodeStructureIndex;
try {
  index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as CodeStructureIndex;
} catch {
  index = await new CodeStructureIndexProvider(root).build();
}

const provider = new CodeStructureIndexProvider(root);
provider.loadIndex(index);

const output = (() => {
  switch (operation) {
    case 'find':
      return provider.find({ text: args[0], kind: args[1] as import('../src/structure/types.js').CodeNodeKind });
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
