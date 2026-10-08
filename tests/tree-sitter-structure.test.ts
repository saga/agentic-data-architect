import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TreeSitterCodeStructureProvider } from '../src/structure/tree-sitter-provider.js';

test('extracts Java, Python and C# declarations with stable ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ada-tree-sitter-'));
  await fs.writeFile(path.join(root, 'Main.java'), 'class Main { void run() { helper(); } void helper() {} }\n');
  await fs.writeFile(path.join(root, 'app.py'), 'class App:\n    def run(self):\n        helper()\n    def helper(self):\n        pass\n');
  await fs.writeFile(path.join(root, 'Service.cs'), 'class Service { void Run() { Helper(); } void Helper() {} }\n');
  const index = await new TreeSitterCodeStructureProvider(root).build();
  assert.ok(index.nodes.some(n => n.kind === 'class' && n.name === 'Main'));
  assert.ok(index.nodes.some(n => n.kind === 'method' && n.name === 'run'));
  assert.ok(index.nodes.some(n => n.kind === 'class' && n.name === 'App'));
  assert.ok(index.nodes.some(n => n.kind === 'function' && n.name === 'run'));
  assert.ok(index.nodes.some(n => n.kind === 'class' && n.name === 'Service'));
  assert.ok(index.nodes.some(n => n.kind === 'method' && n.name === 'Run'));
});
