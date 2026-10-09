import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqlglotParser, splitStatements } from '../src/analysis/sql-parser.js';
import { buildLineage } from '../src/analysis/lineage.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const parser = new SqlglotParser();

async function parse(sql: string) {
  return parser.parseFile('test.sql', sql);
}

describe('splitStatements (no bridge needed)', () => {
  it('splits on top-level semicolons, ignores those in strings/comments', () => {
    const chunks = splitStatements(`SELECT ';' AS a; -- comment ;\nSELECT 2; /* ; */ SELECT 3`);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]?.lineStart, 1);
  });
});

describe('sqlglot parser', () => {
  it('CREATE VIEW with CTE + JOIN resolves base tables, not CTE names', async () => {
    const [st] = await parse(
      `WITH p AS (SELECT security_id, position_qty FROM ibor_position)
       SELECT p.security_id, p.position_qty * s.close_price AS market_value
       FROM p JOIN security_price s ON s.security_id = p.security_id`,
    );
    assert.ok(st);
    assert.deepEqual([...st.sources].sort(), ['ibor_position', 'security_price']);
    const mv = st.columns.filter((c) => c.targetColumn === 'market_value');
    assert.deepEqual(
      mv.map((c) => `${c.sourceDataset}.${c.sourceColumn}`).sort(),
      ['ibor_position.position_qty', 'security_price.close_price'],
    );
  });

  it('INSERT INTO target with schema-qualified source', async () => {
    const [st] = await parse(`INSERT INTO cur.pos SELECT a, b FROM src.raw`);
    assert.equal(st?.target, 'cur.pos');
    assert.deepEqual(st?.sources, ['src.raw']);
  });

  it('MERGE preserves the write target and source dataset dependency', async () => {
    const [st] = await parse(
      'MERGE INTO target_table t USING source_table s ON t.id = s.id ' +
      'WHEN MATCHED THEN UPDATE SET value = s.value ' +
      'WHEN NOT MATCHED THEN INSERT (id, value) VALUES (s.id, s.value)',
    );
    assert.equal(st?.target, 'target_table');
    assert.equal(st?.dialect, undefined);
    assert.deepEqual(st?.sources, ['source_table']);
  });

  it('quoted identifiers and multi-statement files', async () => {
    const stmts = await parse(`CREATE VIEW "V" AS SELECT x FROM "Sch".t; SELECT 1`);
    assert.equal(stmts.length, 2);
    assert.equal(stmts[0]?.target, 'V');
    assert.deepEqual(stmts[0]?.sources, ['Sch.t']);
  });

  it('nested subquery resolves through derived table alias', async () => {
    const [st] = await parse(
      `CREATE VIEW v AS SELECT d.sec_id FROM (SELECT sec_id FROM legacy_position) d`,
    );
    assert.equal(st?.target, 'v');
    assert.deepEqual(st?.sources, ['legacy_position']);
    assert.equal(st?.columns[0]?.sourceDataset, 'legacy_position');
  });

  it('unparsable statement is skipped, rest survive', async () => {
    const stmts = await parse(`SELECT a FROM t1; THIS IS NOT SQL ((((; SELECT b FROM t2`);
    const targets = stmts.map((s) => s.sources.join(','));
    assert.ok(targets.includes('t1'));
    assert.ok(targets.includes('t2'));
    const fp = await parser.parseFile('test.sql', `SELECT a FROM t1; THIS IS NOT SQL ((((; SELECT b FROM t2`);
    assert.equal(fp.length, 2);
  });
});

describe('dialect detection', () => {
  it('records the detected dialect for Oracle, PostgreSQL and Snowflake SQL', async () => {
    const oracle = await parser.parseFileDetailed!('oracle.sql', 'SELECT SYSDATE FROM DUAL');
    assert.equal(oracle.statements[0]?.dialect, 'oracle');
    const postgres = await parser.parseFileDetailed!('postgres.sql', 'SELECT value::jsonb FROM public.events');
    assert.equal(postgres.statements[0]?.dialect, 'postgres');
    const snowflake = await parser.parseFileDetailed!(
      'snowflake.sql',
      'SELECT payload FROM events QUALIFY ROW_NUMBER() OVER (ORDER BY event_id) = 1',
    );
    assert.equal(snowflake.statements[0]?.dialect, 'snowflake');
  });

  it('preserves parse failures for individual statements', async () => {
    const result = await parser.parseFileDetailed!(
      'mixed.sql',
      'SELECT a FROM t1; THIS IS NOT SQL ((((; SELECT b FROM t2',
    );
    assert.equal(result.statements.length, 2);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.error ?? '', /parse failed/i);
  });
});

describe('buildLineage emits evidence with provenance', () => {
  it('statement + edge evidence carry file, lines, hash, run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lin-'));
    const fp = path.join(dir, 'a.sql');
    writeFileSync(fp, `CREATE VIEW v AS SELECT x FROM t1;`);
    const g = await buildLineage([
      { path: fp, sha256: 'abc', investigationId: 'inv', discoveryRunId: 'run-001' },
    ]);
    assert.equal(g.edges.length, 1);
    assert.equal(g.edges[0]?.evidenceId.startsWith('ev-'), true);
    const stmtEv = g.evidence.find((e) => e.type === 'sql_statement');
    assert.equal(stmtEv?.file, fp);
    assert.equal(stmtEv?.lineStart, 1);
    assert.equal(stmtEv?.sourceHash, 'abc');
    assert.equal(stmtEv?.discoveryRunId, 'run-001');
    assert.equal(g.columns[0]?.evidenceId, stmtEv?.id);
  });
});
