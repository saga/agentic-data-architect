import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQuestionContext } from '../src/analysis/context.js';
import { emptyEstate, nodeId } from '../src/model/estate.js';
import type { EvidenceRef } from '../src/evidence/types.js';

test('question context exposes evidence ids for column lineage and profiles', () => {
  const evidence: EvidenceRef[] = [
    {
      id: 'ev-sql',
      type: 'sql_statement',
      investigationId: 'inv',
      discoveryRunId: 'run-001',
      source: 'a.sql:1-2',
      collectedAt: new Date().toISOString(),
    },
    {
      id: 'ev-profile',
      type: 'profiling',
      investigationId: 'inv',
      discoveryRunId: 'run-001',
      source: 'postgres:position rows=10',
      dataset: 'position',
      collectedAt: new Date().toISOString(),
    },
    {
      id: 'ev-profile-col',
      type: 'profiling',
      investigationId: 'inv',
      discoveryRunId: 'run-001',
      source: 'postgres:position.quantity null=0.0%',
      dataset: 'position',
      column: 'quantity',
      collectedAt: new Date().toISOString(),
    },
  ];

  const estate = emptyEstate();
  const legacyPositionId = nodeId('dataset', 'legacy_position');
  const positionId = nodeId('dataset', 'position');
  const sourceColumnId = nodeId('column', 'legacy_position.pos_qty');
  const targetColumnId = nodeId('column', 'position.quantity');
  estate.nodes.push(
    { id: legacyPositionId, type: 'dataset', name: 'legacy_position', attributes: {} },
    { id: positionId, type: 'dataset', name: 'position', attributes: {} },
    {
      id: sourceColumnId,
      type: 'column',
      name: 'legacy_position.pos_qty',
      attributes: { expression: 'pos_qty' },
    },
    { id: targetColumnId, type: 'column', name: 'position.quantity', attributes: {} },
  );
  estate.edges.push(
    {
      id: 'e-dataset',
      from: legacyPositionId,
      to: positionId,
      type: 'derived_from',
      evidenceIds: ['ev-sql'],
    },
    {
      id: 'e-column',
      from: sourceColumnId,
      to: targetColumnId,
      type: 'derived_from',
      evidenceIds: ['ev-sql'],
    },
  );

  const result = buildQuestionContext({
    question: 'position quantity',
    estate,
    // The lineage object only signals that SQL lineage has been run. Dataset and
    // column graph data intentionally come from DataEstate above.
    lineage: {
      edges: [],
      tables: [],
      statements: [],
      evidence,
      columns: [],
      parseFailures: [],
    },
    profiles: [
      {
        dataset: 'position',
        rowCount: 10,
        profiledAt: new Date().toISOString(),
        columns: [
          {
            column: 'quantity',
            dataType: 'NUMBER',
            nullable: false,
            rowCount: 10,
            nullCount: 0,
            nullRate: 0,
            distinctCount: 10,
            distinctRate: 1,
          },
        ],
      },
    ],
    findings: [],
    evidence,
  });

  assert.ok(result.text.includes('legacy_position → position'));
  assert.ok(result.text.includes('position.quantity ← legacy_position.pos_qty'));
  assert.ok(result.text.includes('[ev-sql]'));
  assert.ok(result.text.includes('[ev-profile]'));
  assert.ok(result.text.includes('[ev-profile-col]'));
  assert.deepEqual(new Set(result.evidenceIds), new Set(['ev-sql', 'ev-profile', 'ev-profile-col']));
});
