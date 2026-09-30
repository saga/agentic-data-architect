import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverDirectory } from '../src/discovery/scanner.js';
import { assertReadOnly } from '../src/adapters/database.js';
import { profileDataset } from '../src/analysis/profiling.js';
import type { DatabaseAdapter, DataProfile } from '../src/adapters/database.js';

describe('scanner fingerprint', () => {
  it('records sha256/lineCount/modifiedAt; sha changes on edit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scan-'));
    writeFileSync(path.join(dir, 'a.sql'), 'SELECT 1;\nSELECT 2;\n');
    const first = await discoverDirectory(dir, 'run-001');
    const f = first.files[0];
    assert.equal(f?.kind, 'sql');
    assert.equal(f?.lineCount, 3);
    assert.equal(f?.sha256.length, 64);
    assert.ok(f?.modifiedAt);
    appendFileSync(path.join(dir, 'a.sql'), '-- more\n');
    const second = await discoverDirectory(dir, 'run-002');
    assert.notEqual(second.files[0]?.sha256, first.files[0]?.sha256);
  });
});

describe('assertReadOnly', () => {
  it('allows SELECT/WITH, rejects writes and stacked statements', () => {
    assert.doesNotThrow(() => assertReadOnly('SELECT * FROM t LIMIT 10'));
    assert.doesNotThrow(() => assertReadOnly('-- comment\nWITH x AS (SELECT 1) SELECT * FROM x'));
    assert.doesNotThrow(() => assertReadOnly("SELECT ';' AS value"));
    assert.throws(() => assertReadOnly('WITH x AS (SELECT 1) DELETE FROM t'));
    assert.throws(() => assertReadOnly('DELETE FROM t'));
    assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE t'));
    assert.throws(() => assertReadOnly('INSERT INTO t SELECT 1'));
  });
});

const fakeAdapter: DatabaseAdapter = {
  type: 'fake',
  connect: async () => {},
  close: async () => {},
  listDatabases: async () => [],
  listSchemas: async () => [],
  listTables: async () => [],
  getTableMetadata: async (table) => ({
    name: table,
    qualifiedName: table,
    columns: [
      { name: 'id', dataType: 'integer', nullable: false },
      { name: 'note', dataType: 'text', nullable: true },
    ],
  }),
  sample: async () => [],
  profile: async (table): Promise<DataProfile> => ({
    dataset: table,
    rowCount: 4,
    profiledAt: new Date().toISOString(),
    columns: [
      { column: 'id', dataType: 'integer', nullable: false, rowCount: 4, nullCount: 0, nullRate: 0, distinctCount: 4, distinctRate: 1 },
      { column: 'note', dataType: 'text', nullable: true, rowCount: 4, nullCount: 3, nullRate: 0.75, distinctCount: 1, distinctRate: 0.25 },
    ],
  }),
  query: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false }),
};

describe('profileDataset emits metadata + profiling evidence', () => {
  it('evidence is bound to dataset and run', async () => {
    const { profile, evidence } = await profileDataset(fakeAdapter, 'pos', 'inv', 'run-001');
    assert.equal(profile.rowCount, 4);
    assert.ok(evidence.some((e) => e.type === 'metadata' && e.dataset === 'pos'));
    const col = evidence.find((e) => e.column === 'note');
    assert.equal((col?.value as { nullRate: number })?.nullRate, 0.75);
    assert.ok(evidence.every((e) => e.discoveryRunId === 'run-001'));
  });
});
