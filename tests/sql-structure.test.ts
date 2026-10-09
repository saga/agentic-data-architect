import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectSqlDialect, SqlCodeStructureProvider } from '../src/structure/sql-provider.js';

test('detects PostgreSQL, Oracle and Snowflake dialect signals', () => {
  assert.equal(detectSqlDialect('SELECT value::jsonb FROM t', 'mysql'), 'postgres');
  assert.equal(detectSqlDialect('SELECT SYSDATE FROM DUAL', 'mysql'), 'oracle');
  assert.equal(detectSqlDialect('SELECT value FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY id) = 1', 'mysql'), 'snowflake');
  assert.equal(detectSqlDialect('SELECT id FROM t', 'postgres'), 'postgres');
});

test('extracts SQL statements, tables, columns, reads and writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ada-sql-'));
  await fs.writeFile(path.join(root, 'flow.sql'), [
    'SELECT a.id, b.name FROM orders a JOIN customers b ON a.customer_id = b.id;',
    'INSERT INTO orders SELECT * FROM staging_orders;',
  ].join('\n'));
  const index = await new SqlCodeStructureProvider(root).build();
  assert.ok(index.nodes.some(n => n.kind === 'table' && n.name === 'orders'));
  assert.ok(index.nodes.some(n => n.kind === 'table' && n.name === 'customers'));
  assert.ok(index.nodes.some(n => n.kind === 'column' && n.name.endsWith('id')));
  assert.ok(index.edges.some(e => e.kind === 'reads' && index.nodes.find(n => n.id === e.to)?.name === 'orders'));
  assert.ok(index.edges.some(e => e.kind === 'writes' && index.nodes.find(n => n.id === e.to)?.name === 'orders'));
  assert.ok(index.edges.some(e => e.kind === 'reads' && index.nodes.find(n => n.id === e.to)?.name === 'staging_orders'));
  assert.ok(!index.edges.some(e => e.kind === 'writes' && index.nodes.find(n => n.id === e.to)?.name === 'staging_orders'));
  assert.ok(index.edges.some(e => e.kind === 'joins'));
  const statementNodes = index.nodes.filter(n => n.kind === 'statement').sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  assert.equal(statementNodes[0]?.line, 1);
  assert.equal(statementNodes[1]?.line, 2);
  assert.ok(index.edges.some(e => e.kind === 'writes' && e.line === 2));
});
