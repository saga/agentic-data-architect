import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCurrentStateReportGate } from '../src/workflow/report-gate.js';

const evidence = [
  {
    id: 'ev-1',
    type: 'metadata',
    investigationId: 'test',
    source: 'repo:file',
    collectedAt: new Date().toISOString(),
  },
  {
    id: 'ev-2',
    type: 'code_reference',
    investigationId: 'test',
    source: 'repo:service',
    file: 'Service.java',
    sourceHash: 'hash-2',
    collectedAt: new Date().toISOString(),
  },
] as never[];

function snapshot() {
  return {
    currentState: {
      generatedAt: new Date().toISOString(),
      coverage: {
        filesScanned: 10,
        sqlFiles: 3,
        sqlParsedStatements: 3,
        sqlParseFailures: 0,
        datasets: 4,
        connectedDatasets: 3,
        datasetLineageConnectionRate: 0.75,
        columnLineageEdges: 2,
        semanticAssets: 1,
        profiledDatasets: 2,
      },
      sourceOfTruthCandidates: [],
      semanticCandidates: [],
      semanticAssets: [],
      highValueAssets: [],
    },
  } as never;
}

test('report gate rejects a report without Discovery', () => {
  const result = evaluateCurrentStateReportGate(
    { discoveryRuns: [], evidence, claims: [], findings: [] },
    snapshot(),
  );
  assert.equal(result.passed, false);
});

test('report gate rejects claims whose status exceeds their evidence', () => {
  const result = evaluateCurrentStateReportGate(
    {
      discoveryRuns: [{ id: 'run-1' }],
      evidence,
      claims: [
        {
          status: 'supported',
          evidenceIds: ['ev-1'],
        },
      ],
      findings: [],
    },
    snapshot(),
  );
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.name.includes('Claim') && !check.passed));
});

test('report gate passes a discovered report with evidence-backed claims', () => {
  const result = evaluateCurrentStateReportGate(
    {
      discoveryRuns: [{ id: 'run-1' }],
      evidence,
      claims: [
        {
          status: 'supported',
          evidenceIds: ['ev-1', 'ev-2'],
        },
      ],
      findings: [{ evidenceIds: ['ev-1'] }],
    },
    snapshot(),
  );
  assert.equal(result.passed, true);
});
