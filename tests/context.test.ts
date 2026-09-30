import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQuestionContext } from '../src/analysis/context.js';
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
  const result = buildQuestionContext({
    question: 'position quantity',
    lineage: {
      edges: [],
      tables: ['position'],
      statements: [],
      evidence,
      columns: [
        {
          sourceDataset: 'legacy_position',
          sourceColumn: 'pos_qty',
          targetDataset: 'position',
          targetColumn: 'quantity',
          expression: 'pos_qty',
          statementId: 's1',
          evidenceId: 'ev-sql',
        },
      ],
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
  assert.ok(result.text.includes('[ev-sql]'));
  assert.ok(result.text.includes('[ev-profile]'));
  assert.ok(result.text.includes('[ev-profile-col]'));
  assert.deepEqual(new Set(result.evidenceIds), new Set(['ev-sql', 'ev-profile', 'ev-profile-col']));
});
