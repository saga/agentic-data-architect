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

test('unresolved source-of-truth candidates never count as a covered data source', () => {
  const derived = evaluateDerivedState(state({ sourceOfTruthCandidateCount: 2 }));
  assert.equal(derived.dataSourceReady, false);
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

test('current data architecture readiness is blocked by missing flow, model, or transformation facts', () => {
  const noFlow = evaluateDerivedState(state({ lineageEdgeCount: 0 }));
  assert.equal(noFlow.currentDataArchitectureReady, false);

  const noModel = evaluateDerivedState(state({ estateColumnCount: 0 }));
  assert.equal(noModel.currentDataArchitectureReady, false);

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
  assert.equal(sqlGap.currentDataArchitectureReady, false);
});
