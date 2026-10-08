import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateModernizationGate } from '../src/workflow/modernization-gate.js';
import type { ModernizationPlan } from '../src/model/modernization.js';

const now = new Date().toISOString();

function plan(overrides: Partial<ModernizationPlan> = {}): ModernizationPlan {
  return {
    id: 'modernization-test',
    title: '测试改造',
    status: 'in_review',
    version: 2,
    generatedAt: now,
    goal: '测试',
    scope: ['portfolio'],
    currentState: { datasets: 1, lineageCoverage: 1, parseFailures: 0, semanticAssets: 1, findings: 0 },
    analysisCases: [],
    gaps: [],
    targetArchitecture: {
      id: 'target-test', type: 'target_architecture', title: '目标架构', status: 'in_review', version: 2,
      createdAt: now, updatedAt: now, evidenceIds: ['ev-1'], findingIds: [], decisionIds: [],
      principles: ['保留关键业务结果'],
      components: [{ id: 'component:1', type: 'domain_data', name: 'Position', description: '目标 Position 数据集', dependsOn: [], sourceAssets: ['legacy_position'] }],
      openQuestions: [],
    },
    migrationStages: [],
    mappings: [{
      id: 'map-1', type: 'source_to_target', title: 'legacy_position → position', status: 'proposed', version: 1,
      createdAt: now, updatedAt: now, evidenceIds: ['ev-1'], findingIds: [], decisionIds: [],
      sourceAsset: 'legacy_position', targetAsset: 'position', transformation: '直接映射',
      businessRule: '保留有效持仓', validationRule: '数量和金额逐条核对',
    }],
    decisions: [],
    validationPlan: {
      id: 'validation-1', type: 'modernization_plan', title: '验证', status: 'in_review', version: 2,
      createdAt: now, updatedAt: now, evidenceIds: ['ev-1'], findingIds: [], decisionIds: [], scope: ['portfolio'],
      checks: [
        { id: 'validation:reconciliation', type: 'reconciliation', name: '新旧对比', description: '前后结果对比', status: 'passed', blocking: true, evidenceIds: ['ev-1'], result: '100 条记录逐条一致，金额合计一致。' },
      ],
      cutoverCriteria: ['关键业务指标一致'], rollbackCriteria: ['关键指标持续偏差'],
    },
    mappingCoverage: { sourceAssets: ['legacy_position'], unmappedAssets: [], unmappedAssetDispositions: [] },
    evidenceIds: ['ev-1'],
    ...overrides,
  };
}

test('target gate rejects empty draft even when Agent claimed success', () => {
  const value = plan({ targetArchitecture: { ...plan().targetArchitecture, status: 'draft', components: [], evidenceIds: [] } });
  const result = evaluateModernizationGate(value, new Set(['ev-1']), 'target', '/tmp/modernization-plan.json');
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.name.includes('目标架构') && !check.passed));
});

test('mapping gate requires explicit disposition for intentionally unmapped assets', () => {
  const value = plan({ mappingCoverage: { sourceAssets: ['legacy_position', 'legacy_account'], unmappedAssets: ['legacy_account'] } });
  const blocked = evaluateModernizationGate(value, new Set(['ev-1']), 'mapping', '/tmp/modernization-plan.json');
  assert.equal(blocked.passed, false);
  assert.ok(blocked.checks.some((check) => check.name.includes('覆盖范围') && !check.passed));

  const disposed = plan({ mappingCoverage: {
    sourceAssets: ['legacy_position', 'legacy_account'],
    unmappedAssets: ['legacy_account'],
    unmappedAssetDispositions: [{ asset: 'legacy_account', disposition: 'obsolete', reason: '已确认是废弃测试表。' }],
  }});
  const passed = evaluateModernizationGate(disposed, new Set(['ev-1']), 'mapping', '/tmp/modernization-plan.json');
  assert.equal(passed.passed, true);
});

test('mapping gate allows a mapping stage with no mappings when every source is explicitly excluded', () => {
  const value = plan({
    mappings: [],
    mappingCoverage: {
      sourceAssets: ['legacy_position', 'legacy_account'],
      unmappedAssets: ['legacy_position', 'legacy_account'],
      unmappedAssetDispositions: [
        { asset: 'legacy_position', disposition: 'obsolete', reason: '旧表已确认废弃。' },
        { asset: 'legacy_account', disposition: 'out-of-scope', reason: '本次改造明确不包含该来源。' },
      ],
    },
  });
  const result = evaluateModernizationGate(value, new Set(['ev-1']), 'mapping', '/tmp/modernization-plan.json');
  assert.equal(result.passed, true);
});

test('mapping gate allows proposed draft mappings to remain incomplete', () => {
  const proposed = plan({
    mappings: [{
      ...plan().mappings[0],
      status: 'proposed',
      evidenceIds: [],
      transformation: undefined,
      businessRule: undefined,
      validationRule: undefined,
    }],
  });
  const result = evaluateModernizationGate(
    proposed,
    new Set(['ev-1']),
    'mapping',
    '/tmp/modernization-plan.json',
  );

  assert.equal(result.passed, true);
});

test('validation gate rejects ready-only checks and passes only persisted results', () => {
  const notExecuted = plan({
    validationPlan: {
      ...plan().validationPlan,
      checks: [{ id: 'validation:reconciliation', type: 'reconciliation', name: '新旧对比', description: '前后结果对比', status: 'ready', blocking: true, evidenceIds: ['ev-1'] }],
    },
  });
  const failed = evaluateModernizationGate(notExecuted, new Set(['ev-1']), 'validation', '/tmp/modernization-plan.json');
  assert.equal(failed.passed, false);

  const passed = evaluateModernizationGate(plan(), new Set(['ev-1']), 'validation', '/tmp/modernization-plan.json');
  assert.equal(passed.passed, true);
});