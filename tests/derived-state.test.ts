import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDerivedState } from '../src/workflow/derived-state.js';

function state(overrides: Partial<Parameters<typeof evaluateDerivedState>[0]> = {}) {
  return {
    goal: '理解当前数据架构',
    currentState: {
      coverage: {
        sqlFiles: 2,
        sqlParsedStatements: 2,
        sqlParseFailures: 0,
        datasets: 4,
        connectedDatasets: 4,
        semanticAssets: 1,
      },
    },
    estateColumnCount: 12,
    sourceOfTruthCandidateCount: 0,
    lineageEdgeCount: 6,
    findingsCount: 2,
    scopeReady: true,
    highGapKinds: [],
    modernization: null,
    assessment: null,
    ...overrides,
  };
}

test('a partial current-state signal is enough to continue current architecture analysis', () => {
  const derived = evaluateDerivedState(state({
    currentState: {
      coverage: {
        sqlFiles: 2,
        sqlParsedStatements: 1,
        sqlParseFailures: 1,
        datasets: 0,
        connectedDatasets: 0,
        semanticAssets: 0,
      },
    },
    estateColumnCount: 0,
    lineageEdgeCount: 0,
  }));
  assert.equal(derived.currentStateAvailable, true);
  assert.equal(derived.currentDataArchitectureReady, true);
  assert.equal(derived.dataSourceReady, false);
  assert.equal(derived.dataFlowReady, false);
  assert.equal(derived.dataModelReady, false);
});

test('source-of-truth candidates remain valid data-source coverage but do not prove data truth', () => {
  const derived = evaluateDerivedState(state({ sourceOfTruthCandidateCount: 2 }));
  assert.equal(derived.dataSourceReady, true);
  assert.equal(derived.dataTruthReady, false);
});

test('Current Data Architecture can remain readable even when a business source is still unresolved', () => {
  const derived = evaluateDerivedState(state({ sourceOfTruthCandidateCount: 2 }));
  assert.equal(derived.currentDataArchitectureReady, true);
});

test('assessment completion is valid with zero findings when the assessment artifact exists', () => {
  const derived = evaluateDerivedState(state({
    findingsCount: 0,
    assessment: {
      exists: true,
      findingsCount: 0,
      recommendationCount: 0,
      roadmapCount: 0,
    },
  }));
  assert.equal(derived.assessmentFindingsReady, true);
  assert.equal(derived.assessmentRecommendationReady, true);
  assert.equal(derived.assessmentRoadmapReady, true);
  assert.equal(derived.findingsReady, true);
});

test('assessment requires recommendations and roadmap when findings produce work', () => {
  const incomplete = evaluateDerivedState(state({
    assessment: {
      exists: true,
      findingsCount: 3,
      recommendationCount: 2,
      roadmapCount: 0,
    },
  }));
  assert.equal(incomplete.assessmentFindingsReady, true);
  assert.equal(incomplete.assessmentRecommendationReady, true);
  assert.equal(incomplete.assessmentRoadmapReady, false);

  const complete = evaluateDerivedState(state({
    assessment: {
      exists: true,
      findingsCount: 3,
      recommendationCount: 2,
      roadmapCount: 1,
    },
  }));
  assert.equal(complete.assessmentRoadmapReady, true);
});

test('modernization readiness is derived from persisted status semantics in one place', () => {
  const targetOnly = evaluateDerivedState(state({
    modernization: {
      targetStatus: 'in_review',
      targetComponentCount: 2,
      mappingStatuses: ['proposed'],
      validationStatuses: [{ status: 'planned', blocking: true }],
    },
  }));
  assert.equal(targetOnly.targetArchitectureReady, true);
  assert.equal(targetOnly.mappingReady, false);
  assert.equal(targetOnly.mappingCount, 0);
  assert.equal(targetOnly.validationReady, false);
  assert.equal(targetOnly.validationCount, 1);

  const complete = evaluateDerivedState(state({
    modernization: {
      targetStatus: 'in_review',
      targetComponentCount: 2,
      mappingStatuses: ['reviewed', 'approved'],
      validationStatuses: [{ status: 'passed', blocking: true }],
    },
  }));
  assert.equal(complete.targetArchitectureReady, true);
  assert.equal(complete.mappingReady, true);
  assert.equal(complete.mappingCount, 2);
  assert.equal(complete.validationReady, true);
});

test('current data architecture keeps partial facts instead of blocking on missing analysis dimensions', () => {
  const noFlow = evaluateDerivedState(state({ lineageEdgeCount: 0 }));
  assert.equal(noFlow.dataFlowReady, false);
  assert.equal(noFlow.currentDataArchitectureReady, true);

  const noModel = evaluateDerivedState(state({ estateColumnCount: 0 }));
  assert.equal(noModel.dataModelReady, false);
  assert.equal(noModel.currentDataArchitectureReady, true);

  const sqlGap = evaluateDerivedState(state({
    currentState: {
      coverage: {
        sqlFiles: 2,
        sqlParsedStatements: 1,
        sqlParseFailures: 1,
        datasets: 4,
        connectedDatasets: 4,
        semanticAssets: 1,
      },
    },
  }));
  assert.equal(sqlGap.currentDataArchitectureReady, true);
});

test('high discovery or lineage gaps do not block a usable current-state result', () => {
  const derived = evaluateDerivedState(state({ highGapKinds: ['lineage'] }));
  assert.equal(derived.currentStateReady, true);
  assert.equal(derived.currentDataArchitectureReady, true);
});
