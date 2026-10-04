import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  closeLocalAnalytics,
  localQuery,
  localExplain,
  localReconcile,
  localTransform,
  localExportParquet,
  registerLocalDataset,
  validateLocalReadOnlySql,
} from '../src/analytics/local-data.js';
import { loadWorkspaceContext } from '../src/investigation/workspace.js';

test('local SQL only permits read-only single statements', () => {
  assert.equal(
    validateLocalReadOnlySql('select count(*) from raw.ds_demo'),
    'select count(*) from raw.ds_demo',
  );
  assert.throws(
    () => validateLocalReadOnlySql('delete from raw.ds_demo'),
    /只允许执行 SELECT 或 WITH|不允许/,
  );
  assert.throws(
    () => validateLocalReadOnlySql("select * from read_csv_auto('secret.csv')"),
    /不能自己读取文件/,
  );
  assert.throws(
    () => validateLocalReadOnlySql('select 1; select 2'),
    /一次只能执行一条查询/,
  );
});

test('DuckDB reconciliation and explain produce deterministic Evidence', async () => {
  const sessionName = 'test-reconcile-' + randomUUID().slice(0, 8);
  const sessionRoot = path.resolve('.workspace', sessionName);
  const uploadsDir = path.join(sessionRoot, 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });

  try {
    await fs.writeFile(path.join(uploadsDir, 'source.csv'), 'security_id,quantity\nAAPL,10\nMSFT,5\n', 'utf8');
    await fs.writeFile(path.join(uploadsDir, 'target.csv'), 'security_id,quantity\nAAPL,11\nMSFT,5\n', 'utf8');

    const source = await registerLocalDataset(sessionName, 'uploads/source.csv', 'Source');
    const target = await registerLocalDataset(sessionName, 'uploads/target.csv', 'Target');
    const reconciliation = await localReconcile(
      sessionName,
      source.relation,
      target.relation,
      ['security_id'],
      ['quantity'],
    );

    assert.equal(reconciliation.source.rowCount, 2);
    assert.equal(reconciliation.target.rowCount, 2);
    assert.equal(reconciliation.sourceDuplicateGroups, 0);
    assert.equal(reconciliation.targetDuplicateGroups, 0);
    assert.equal(reconciliation.missingRows, 0);
    assert.equal(reconciliation.extraRows, 0);
    assert.equal(reconciliation.matchRate, 1);
    assert.equal(reconciliation.measures[0]?.sourceSum, 15);
    assert.equal(reconciliation.measures[0]?.targetSum, 16);
    assert.equal(reconciliation.measures[0]?.difference, 1);
    assert.equal(reconciliation.measures[0]?.mismatchKeys, 1);

    const context = await loadWorkspaceContext(sessionName);
    assert.ok(context.evidence.some((item) => item.id === reconciliation.evidenceId));

    const explain = await localExplain(sessionName, 'SELECT count(*) AS row_count FROM ' + source.relation);
    assert.ok(explain.rowCount > 0);
    assert.ok(explain.evidenceId);
  } finally {
    closeLocalAnalytics();
    await fs.rm(sessionRoot, { recursive: true, force: true });
  }
});
test('local dataset rejects symlinks that escape the Investigation workspace', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation is environment-dependent on Windows CI');
    return;
  }

  const sessionName = 'test-symlink-' + randomUUID().slice(0, 8);
  const sessionRoot = path.resolve('.workspace', sessionName);
  const outsideDir = path.resolve('.workspace-symlink-target-' + randomUUID().slice(0, 8));
  const uploadsDir = path.join(sessionRoot, 'uploads');

  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  try {
    const outsideFile = path.join(outsideDir, 'outside.csv');
    const linkedFile = path.join(uploadsDir, 'linked.csv');
    await fs.writeFile(outsideFile, 'security_id,quantity\\nAAPL,10\\n', 'utf8');
    await fs.symlink(outsideFile, linkedFile);

    await assert.rejects(
      () => registerLocalDataset(sessionName, 'uploads/linked.csv'),
      /符号链接离开当前 Investigation workspace/,
    );
  } finally {
    closeLocalAnalytics();
    await fs.rm(sessionRoot, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('workspace CSV becomes a DuckDB dataset with Evidence provenance', async () => {
  const sessionName = 'test-local-' + randomUUID().slice(0, 8);
  const sessionRoot = path.resolve('.workspace', sessionName);
  const uploadsDir = path.join(sessionRoot, 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });
  const csvPath = path.join(uploadsDir, 'positions.csv');

  try {
    await fs.writeFile(
      csvPath,
      'security_id,quantity,price\nAAPL,10,230.5\nMSFT,5,510.2\n',
      'utf8',
    );

    const dataset = await registerLocalDataset(sessionName, 'uploads/positions.csv', 'Positions');
    assert.equal(dataset.format, 'csv');
    assert.equal(dataset.version, 1);
    assert.match(dataset.relation, /^raw\.ds_[0-9a-f]+$/);

    const result = await localQuery(
      sessionName,
      'SELECT security_id, quantity FROM ' + dataset.relation + ' ORDER BY security_id',
      10,
    );

    assert.equal(result.rowCount, 2);
    assert.equal(result.rows[0]?.security_id, 'AAPL');
    // DuckDB JSON materialization returns BIGINT as a string; preserve precision in the runtime API.
    assert.equal(Number(result.rows[1]?.quantity), 5);

    const context = await loadWorkspaceContext(sessionName);
    const evidence = context.evidence.find((item) => item.id === result.evidenceId);
    assert.ok(evidence);
    assert.equal(evidence?.type, 'query_result');
    assert.equal(evidence?.sourceHash, dataset.sha256);
    assert.equal(evidence?.discoveryRunId.startsWith('local:analysis-'), true);
    const transformed = await localTransform(
      sessionName,
      'analysis',
      'position_value',
      'SELECT security_id, quantity * price AS market_value FROM ' + dataset.relation,
    );
    assert.equal(transformed.schema, 'analysis');
    assert.equal(transformed.rowCount, 2);

    const exported = await localExportParquet(
      sessionName,
      'SELECT * FROM ' + transformed.relation + ' ORDER BY security_id',
      'parquet/position_value.parquet',
    );
    assert.equal(exported.format, 'parquet');
    assert.equal(exported.version, 1);
    assert.equal(exported.relativePath, 'parquet/position_value.parquet');
  } finally {
    closeLocalAnalytics();
    await fs.rm(sessionRoot, { recursive: true, force: true });
  }
});
