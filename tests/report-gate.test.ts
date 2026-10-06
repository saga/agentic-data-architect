import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateInvestigationReportGate } from '../src/workflow/report-gate.js';

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

function base() {
  return {
    mission: {
      version: 1 as const,
      purpose: '理解系统当前数据架构。',
      expectedResult: '形成可以直接阅读的调查报告。',
      deliverables: [{ id: 'report', title: '调查报告', description: '说明调查结果。', required: true }],
      status: 'confirmed' as const,
      confirmedAt: new Date().toISOString(),
      confirmedBy: 'user' as const,
    },
    goal: '理解系统当前数据架构。',
    scope: ['Position'],
    systems: ['Portfolio System'],
    scopeValidation: {
      status: 'validated',
      goal: '理解系统当前数据架构。',
      scope: ['Position'],
      systems: ['Portfolio System'],
      source: 'user' as const,
      userConfirmed: true,
      evidenceIds: [],
      validatedAt: new Date().toISOString(),
    },
    evidence,
    claims: [],
    findings: [],
    resultArtifactCount: 1,
  };
}

function snapshot() {
  return {
    run: { id: 'run-1', scopeFingerprint: 'not-used-by-test' },
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

test('report gate rejects an investigation without a confirmed mission', () => {
  const input = base();
  input.mission = undefined;
  const result = evaluateInvestigationReportGate(input, snapshot());
  assert.equal(result.passed, false);
});

test('report gate rejects an investigation without scope validation', () => {
  const input = base();
  input.scopeValidation = undefined;
  const result = evaluateInvestigationReportGate(input, snapshot());
  assert.equal(result.passed, false);
});

test('report gate rejects a result with unsupported claims', () => {
  const input = base();
  input.claims = [{
    status: 'supported',
    evidenceIds: ['ev-1'],
  }];
  const result = evaluateInvestigationReportGate(input, snapshot());
  assert.equal(result.passed, false);
});

test('report gate passes a valid non-empty investigation result', () => {
  const input = base();
  input.claims = [{
    status: 'supported',
    evidenceIds: ['ev-1', 'ev-2'],
  }];
  input.findings = [{ evidenceIds: ['ev-1'] }];
  const result = evaluateInvestigationReportGate(input, snapshot());
  assert.equal(result.passed, true);
});
