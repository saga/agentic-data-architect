import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TreeSitterCodeStructureProvider } from '../src/structure/tree-sitter-provider.js';

test('Tree-sitter provider loads Java/Python from VS Code WASM and C# from its published grammar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-structure-'));
  try {
    await fs.writeFile(
      path.join(root, 'Sample.java'),
      'public class Sample { public void run() { helper(); } private void helper() {} }',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'sample.py'),
      'class Sample:\n    def run(self):\n        helper()\n    def helper(self):\n        pass\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'Sample.cs'),
      'public class Sample { public void Run() { Helper(); } private void Helper() {} }',
      'utf8',
    );

    const output = path.join(root, '.code-structure', 'index.json');
    const provider = new TreeSitterCodeStructureProvider(root, output);
    const index = await provider.build();

    assert.deepEqual(
      index.files.map((file) => file.path),
      ['Sample.cs', 'Sample.java', 'sample.py'],
    );
    assert.equal(index.files.find((file) => file.path.endsWith('.java'))?.parser, 'tree-sitter-java');
    assert.equal(index.files.find((file) => file.path.endsWith('.py'))?.parser, 'tree-sitter-python');
    assert.equal(index.files.find((file) => file.path.endsWith('.cs'))?.parser, 'tree-sitter-csharp');

    assert.ok(index.nodes.some((node) => node.file === 'Sample.java' && node.kind === 'class' && node.name === 'Sample'));
    assert.ok(index.nodes.some((node) => node.file === 'Sample.java' && node.kind === 'method' && node.name === 'run'));
    assert.ok(index.nodes.some((node) => node.file === 'sample.py' && node.kind === 'class' && node.name === 'Sample'));
    assert.ok(index.nodes.some((node) => node.file === 'sample.py' && node.kind === 'function' && node.name === 'run'));
    assert.ok(index.nodes.some((node) => node.file === 'Sample.cs' && node.kind === 'class' && node.name === 'Sample'));
    assert.ok(index.nodes.some((node) => node.file === 'Sample.cs' && node.kind === 'method' && node.name === 'Run'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
