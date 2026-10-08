import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TypeScriptCodeStructureProvider } from '../src/structure/typescript-provider.js';

test('builds a deterministic structure index and resolves basic calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ada-structure-'));
  await fs.writeFile(path.join(root, 'a.ts'), [
    'import { b } from "./b.js";',
    'export function a() { return b(); }',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'b.ts'), 'export function b() { return 1; }\n');

  const provider = new TypeScriptCodeStructureProvider(root);
  const index = await provider.build();

  assert.equal(index.version, 1);
  assert.equal(index.files.length, 2);
  assert.ok(index.nodes.some(node => node.kind === 'function' && node.name === 'a'));
  assert.ok(index.nodes.some(node => node.kind === 'function' && node.name === 'b'));

  const a = provider.find({ text: 'a', kind: 'function' })[0];
  const b = provider.find({ text: 'b', kind: 'function' })[0];
  assert.ok(a);
  assert.ok(b);
  assert.ok(provider.callees(a.id).some(node => node.id === b.id));
  assert.ok(provider.callers(b.id).some(node => node.id === a.id));
  assert.ok(provider.trace(a.id, b.id));
});
