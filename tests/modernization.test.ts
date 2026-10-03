import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModernizationGaps } from '../src/analysis/gap.js';
import {
  ArchitectureDecisionSchema,
  ModernizationPlanSchema,
  SourceToTargetMappingSchema,
  TargetArchitectureSchema,
} from '../src/model/modernization.js';

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
          datasetLineageConnectionRate: 0.5,
          columnLineageEdges: 2,
          semanticAssets: 0,
          profiledDatasets: 1,
        },
        sourceOfTruthCandidates: [{
          key: 'position',
          candidateDatasetIds: ['dataset:position'],
          candidateDatasets: ['position'],
          priorityScore: 2,
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


test('does not treat empty draft work products as confirmed design', () => {
  const target = TargetArchitectureSchema.parse({
    id: 'target-1',
    type: 'target_architecture',
    title: '目标架构（待设计）',
    status: 'draft',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceIds: [],
    findingIds: [],
    decisionIds: [],
    principles: [],
    components: [],
    openQuestions: ['明确业务范围'],
  });
  assert.equal(target.components.length, 0);

  assert.throws(() => TargetArchitectureSchema.parse({
    ...target,
    status: 'approved',
  }));

  assert.throws(() => ArchitectureDecisionSchema.parse({
    id: 'decision-1',
    type: 'architecture_decision',
    title: '测试决定',
    status: 'approved',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceIds: [],
    findingIds: [],
    decisionIds: [],
    context: '测试上下文',
    options: ['方案 A', '方案 B'],
    decision: '方案 A',
    rationale: '测试依据',
    tradeoffs: [],
  }));

  assert.throws(() => SourceToTargetMappingSchema.parse({
    id: 'mapping-1',
    type: 'source_to_target',
    title: '测试 Mapping',
    status: 'approved',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceIds: [],
    findingIds: [],
    decisionIds: [],
    sourceAsset: 'legacy_position',
    targetAsset: 'position',
  }));
});
