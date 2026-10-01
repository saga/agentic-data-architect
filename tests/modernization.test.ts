import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModernizationGaps } from '../src/analysis/gap.js';
import { ModernizationPlanSchema } from '../src/model/modernization.js';

describe('Modernization workbench', () => {
  it('turns current-state coverage and findings into explicit gaps', () => {
    const gaps = buildModernizationGaps({
      currentState: {
        generatedAt: new Date().toISOString(),
        coverage: {
          filesScanned: 3,
          sqlFiles: 2,
          sqlParsedStatements: 1,
          sqlParseFailures: 1,
          datasets: 4,
          connectedDatasets: 2,
          datasetLineageCoverage: 0.5,
          columnLineageEdges: 2,
          semanticAssets: 0,
          profiledDatasets: 1,
        },
        sourceOfTruthCandidates: [{
          key: 'position',
          candidateDatasetIds: ['dataset:position'],
          candidateDatasets: ['position'],
          score: 2,
          reasons: ['downstream usage'],
          evidenceIds: ['ev-1'],
        }],
        semanticCandidates: [],
        semanticAssets: [],
        highValueAssets: ['dataset:position'],
      },
      estate: null,
      findings: [],
    });

    assert.ok(gaps.some((gap) => gap.kind === 'discovery'));
    assert.ok(gaps.some((gap) => gap.kind === 'lineage'));
    assert.ok(gaps.some((gap) => gap.kind === 'semantic'));
    assert.ok(gaps.some((gap) => gap.title.includes('Source-of-Truth')));
  });

  it('keeps modernization work products runtime validated', () => {
    const result = ModernizationPlanSchema.safeParse({
      id: 'modernization-1',
      title: 'Legacy modernization',
      status: 'draft',
      version: 1,
      generatedAt: new Date().toISOString(),
      goal: 'Modernize portfolio data',
      scope: ['portfolio'],
      currentState: {
        datasets: 2,
        lineageCoverage: 0.9,
        parseFailures: 0,
        semanticAssets: 2,
        findings: 1,
      },
      analysisCases: [],
      gaps: [],
      targetArchitecture: {
        id: 'target-1',
        type: 'target_architecture',
        title: 'Target',
        status: 'draft',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        evidenceIds: [],
        findingIds: [],
        decisionIds: [],
        principles: ['Evidence-backed design'],
        components: [],
        openQuestions: [],
      },
      migrationStages: [],
      mappings: [],
      decisions: [],
      validationPlan: {
        id: 'validation-1',
        type: 'modernization_plan',
        title: 'Validation',
        status: 'draft',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        evidenceIds: [],
        findingIds: [],
        decisionIds: [],
        scope: ['portfolio'],
        checks: [{
          id: 'check-1',
          type: 'coverage',
          name: 'Coverage',
          description: 'Check coverage',
          status: 'ready',
          blocking: true,
          evidenceIds: [],
        }],
        cutoverCriteria: ['All blocking checks pass'],
        rollbackCriteria: ['Critical mismatch'],
      },
      evidenceIds: [],
    });
    assert.equal(result.success, true);
  });
});
