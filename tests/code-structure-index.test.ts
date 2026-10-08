import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TypeScriptCodeStructureProvider } from '../src/structure/typescript-provider.js';

test('uses stable node ids based on file, kind, name, and same-name ordinal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ada-structure-stable-'));
  const writeSource = async (prefix: string) => {
    await fs.writeFile(path.join(root, 'a.ts'), [
      prefix,
      'export function same() { return 1; }',
      'export function same() { return 2; }',
      'export function caller() { return same(); }',
    ].filter(Boolean).join('\\n') + '\\n');
  };

  await writeSource('');
  const first = await new TypeScriptCodeStructureProvider(root).build();
  const firstSame = first.nodes.filter(node => node.kind === 'function' && node.name === 'same');
  assert.deepEqual(firstSame.map(node => node.id), [
    'a.ts#function#same#0',
    'a.ts#function#same#1',
  ]);

  // 在同一个文件前面插入内容，原有声明的 ID 不应因为行号变化而变化。
  await writeSource('// inserted line');
  const second = await new TypeScriptCodeStructureProvider(root).build();
  const secondSame = second.nodes.filter(node => node.kind === 'function' && node.name === 'same');
  assert.deepEqual(secondSame.map(node => node.id), firstSame.map(node => node.id));

  const caller = second.nodes.find(node => node.kind === 'function' && node.name === 'caller');
  assert.equal(caller?.id, 'a.ts#function#caller#0');
});


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
