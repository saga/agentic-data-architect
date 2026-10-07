import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateInvestigationReportGate } from '../src/workflow/report-gate.js';
import { computeScopeFingerprint } from '../src/investigation/artifact-provenance.js';

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
      deliverables: [{ id: 'custom-result', title: '其他结果', description: '按照用户明确说明的期望结果形成最终交付物。', required: true }],
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
      scopeFingerprint: computeScopeFingerprint({
        scope: ['Position'],
        systems: ['Portfolio System'],
      }),
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
    // 有效场景的快照指纹必须和调查范围对上，否则门禁拦的是快照过期而不是被测逻辑。
    run: {
      id: 'run-1',
      scopeFingerprint: computeScopeFingerprint({
        goal: '理解系统当前数据架构。',
        scope: ['Position'],
        systems: ['Portfolio System'],
      }),
    },
    lineage: { edges: [{ source: 'a', target: 'b' }] },
    estate: { nodes: [{ id: 'column:a.c', type: 'column', name: 'a.c', attributes: {} }] },
    currentState: {
      generatedAt: new Date().toISOString(),
      coverage: {
        filesScanned: 10,
        sqlFiles: 3,
        sqlParsedStatements: 3,
        sqlParseFailures: 0,
        datasets: 4,
        connectedDatasets: 4,
        datasetLineageConnectionRate: 1,
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
  const input = { ...base(), mission: undefined };
  const result = evaluateInvestigationReportGate(input, null);
  assert.equal(result.passed, false);
});

test('report gate rejects an investigation without scope validation', () => {
  const input = { ...base(), scopeValidation: undefined };
  const result = evaluateInvestigationReportGate(input, null);
  assert.equal(result.passed, false);
});

test('report gate rejects a result with unsupported claims', () => {
  const input = {
    ...base(),
    claims: [{
      status: 'supported' as const,
      evidenceIds: ['ev-1'],
    }],
  };
  const result = evaluateInvestigationReportGate(input, null);
  assert.equal(result.passed, false);
});

test('report gate passes a valid non-empty investigation result', () => {
  const input = {
    ...base(),
    claims: [{
      status: 'supported' as const,
      evidenceIds: ['ev-1', 'ev-2'],
    }],
    findings: [{ evidenceIds: ['ev-1'] }],
  };
  const result = evaluateInvestigationReportGate(input, null);
  assert.equal(result.passed, true);
});


test('report gate rejects a stale discovery snapshot', () => {
  const input = base();
  const stale = {
    ...snapshot(),
    run: { id: 'run-1', scopeFingerprint: 'stale-scope' },
  } as never;
  const result = evaluateInvestigationReportGate(input, stale);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.name === '发现结果仍属于当前范围' && !check.passed));
});


test('report gate accepts a valid assessment with zero findings and no roadmap work', () => {
  const input = {
    ...base(),
    workflow: 'data-architecture-assessment',
    findings: [],
    assessmentPlanAvailable: true,
    assessmentRecommendationCount: 0,
    assessmentRoadmapCount: 0,
  };
  const result = evaluateInvestigationReportGate(input, snapshot());
  assert.equal(result.passed, true);
});

test('report gate rejects an assessment that has recommendations but no roadmap', () => {
  const input = {
    ...base(),
    workflow: 'data-architecture-assessment',
    findings: [{ evidenceIds: ['ev-1'] }],
    assessmentPlanAvailable: true,
    assessmentRecommendationCount: 2,
    assessmentRoadmapCount: 0,
  };
  const result = evaluateInvestigationReportGate(input, snapshot());
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.name === '数据架构评估结果已经形成' && !check.passed));
});
