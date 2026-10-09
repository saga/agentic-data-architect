import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodeStructureIndexProvider } from '../src/structure/code-structure-index-provider.js';

test('builds one canonical snapshot across TypeScript, Java, Python, C# and SQL', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ada-structure-all-'));
  await fs.writeFile(path.join(root, 'app.ts'), 'export function run() { return 1; }\n');
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main { void run() {} }\n');
  await fs.writeFile(path.join(root, 'app.py'), 'def run():\n    return 1\n');
  await fs.writeFile(path.join(root, 'Service.cs'), 'class Service { void Run() {} }\n');
  await fs.writeFile(path.join(root, 'flow.sql'), 'SELECT id FROM orders;\n');

  const index = await new CodeStructureIndexProvider(root).build();
  assert.ok(index.files.some(f => f.path === 'app.ts' && f.parser === 'typescript-compiler'));
  assert.ok(index.files.some(f => f.path === 'Main.java' && f.parser === 'tree-sitter-java'));
  assert.ok(index.files.some(f => f.path === 'app.py' && f.parser === 'tree-sitter-python'));
  assert.ok(index.files.some(f => f.path === 'Service.cs' && f.parser === 'csharp-declaration-fallback'));
  assert.ok(index.files.some(f => f.path === 'flow.sql' && ['sqlglot', 'node-sql-parser'].includes(f.parser)));
  assert.ok(index.nodes.some(n => n.kind === 'table' && n.name === 'orders'));
});
