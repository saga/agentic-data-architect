import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodeStructureDuckDBProjector } from '../src/structure/duckdb-projector.js';
import { CodeStructureDuckDBQuery } from '../src/structure/duckdb-query.js';
import type { CodeStructureIndex } from '../src/structure/types.js';

test('projects canonical structure index to DuckDB and queries it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ada-structure-duckdb-'));
  const db = path.join(root, 'structure.duckdb');
  const index: CodeStructureIndex = {
    version: 1,
    root,
    generatedAt: new Date().toISOString(),
    files: [{ path: 'src/a.ts', hash: 'abc', parser: 'typescript-compiler' }],
    nodes: [
      { id: 'src/a.ts#file#src/a.ts#0', kind: 'file', name: 'src/a.ts', file: 'src/a.ts', line: 1 },
      { id: 'src/a.ts#function#foo#0', kind: 'function', name: 'foo', file: 'src/a.ts', line: 2 },
      { id: 'src/a.ts#function#bar#0', kind: 'function', name: 'bar', file: 'src/a.ts', line: 3 },
    ],
    edges: [
      { from: 'src/a.ts#file#src/a.ts#0', to: 'src/a.ts#function#foo#0', kind: 'defines', confidence: 'exact', file: 'src/a.ts', line: 2 },
      { from: 'src/a.ts#function#foo#0', to: 'src/a.ts#function#bar#0', kind: 'calls', confidence: 'exact', file: 'src/a.ts', line: 2 },
    ],
  };
  await new CodeStructureDuckDBProjector(root, db).project(index);
  const query = new CodeStructureDuckDBQuery(db);
  assert.equal((await query.find({ text: 'fo' }))[0]?.id, 'src/a.ts#function#foo#0');
  assert.equal((await query.callers('src/a.ts#function#bar#0'))[0]?.name, 'foo');
  assert.equal((await query.callees('src/a.ts#function#foo#0'))[0]?.name, 'bar');
  const summary = await query.summary();
  assert.equal(summary.nodes, 3);
  assert.equal(summary.edges, 2);
  assert.equal((await query.trace('src/a.ts#function#foo#0', 'src/a.ts#function#bar#0'))?.nodes.length, 2);

  // Re-project through the cached instance while query clients have already opened it.
  // Readers must see the refreshed snapshot, not a stale cached database handle.
  const refreshed: CodeStructureIndex = {
    ...index,
    generatedAt: new Date(Date.now() + 1000).toISOString(),
    nodes: index.nodes.filter(node => node.name !== 'bar'),
    edges: index.edges.filter(edge => edge.to !== 'src/a.ts#function#bar#0'),
  };
  await new CodeStructureDuckDBProjector(root, db).project(refreshed);
  assert.equal((await query.find({ text: 'bar' })).length, 0);
  assert.equal((await query.summary()).nodes, 2);
});
