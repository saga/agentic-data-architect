import fs from 'node:fs/promises';
import path from 'node:path';
import { CodeStructureIndexProvider } from '../src/structure/code-structure-index-provider.js';
import { CodeStructureDuckDBQuery } from '../src/structure/duckdb-query.js';
import type { CodeNodeKind, CodeStructureIndex } from '../src/structure/types.js';

const [rootArg = '.', operation = 'find', ...args] = process.argv.slice(2);
const root = path.resolve(rootArg);
const indexFile = path.join(root, '.code-structure', 'index.json');
const databaseFile = path.join(root, '.code-structure', 'structure.duckdb');

let index: CodeStructureIndex;
try {
  index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as CodeStructureIndex;
} catch {
  index = await new CodeStructureIndexProvider(root).build();
}

const query = new CodeStructureDuckDBQuery(databaseFile);
const output = await (async () => {
  switch (operation) {
    case 'find':
      return query.find({ text: args[0], kind: args[1] as CodeNodeKind });
    case 'callers':
      return query.callers(args[0] ?? '');
    case 'callees':
      return query.callees(args[0] ?? '');
    case 'trace':
      return query.trace(args[0] ?? '', args[1] ?? '', Number(args[2] ?? 8));
    case 'summary':
      return query.summary();
    default:
      throw new Error('operation must be find|callers|callees|trace|summary');
  }
})();
void index;
console.log(JSON.stringify(output, null, 2));
