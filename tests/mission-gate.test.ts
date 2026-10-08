import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateMissionGate,
  formatMissionGateFailure,
  inferMissionDeliverables,
  isMissionWorkflowTargetAllowed,
} from '../src/workflow/mission-gate.js';

test('mission gate rejects vague confirmed text instead of trusting confirmation alone', () => {
  const result = evaluateMissionGate({
    version: 1,
    purpose: '分析一下',
    expectedResult: '给我一些建议',
    deliverables: [{
      id: 'custom-result',
      title: '其他结果',
      description: '按照用户明确说明的期望结果形成最终交付物。',
      required: true,
    }],
    status: 'confirmed',
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user',
  });

  assert.equal(result.passed, false);
  assert.match(formatMissionGateFailure(result), /为什么要做这次调查/);
});

test('mission gate accepts user-confirmed deliverables without re-inferring them from text', () => {
  const purpose = '理解某大型企业老系统当前的数据架构，为 replatform 提供依据。';
  const expectedResult = '拿到当前 Data Source、Data Flow、Data Model。';
  const result = evaluateMissionGate({
    version: 1,
    purpose,
    expectedResult,
    deliverables: [{
      id: 'target-architecture',
      title: '目标架构',
      description: '形成新的数据/应用架构方案及关键设计。',
      required: true,
    }],
    status: 'confirmed',
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user',
  });

  assert.equal(result.passed, true);
  assert.ok(result.checks.some((item) => item.name === '交付物已记录' && item.passed));
});

test('mission gate accepts concise concrete mission text', () => {
  const result = evaluateMissionGate({
    version: 1,
    purpose: '分析 IBM',
    expectedResult: '当前架构说明',
    deliverables: [{
      id: 'current-state-architecture',
      title: '当前架构',
      description: '梳理当前系统的数据架构、主要组件、数据关系和依赖。',
      required: true,
    }],
    status: 'confirmed',
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user',
  });

  assert.equal(result.passed, true);
});

test('mission gate accepts a concrete natural-language purpose without semantic over-review', () => {
  const purpose = '希望调查当前项目的数据流，弄清数据从哪里来、经过什么处理。';
  const expectedResult = '形成完整的数据架构报告，包括 Data Source、Data Flow、Data Model 和 Mermaid 图。';
  const result = evaluateMissionGate({
    version: 1,
    purpose,
    expectedResult,
    deliverables: inferMissionDeliverables(purpose, expectedResult),
    status: 'confirmed',
    confirmedAt: '2026-10-09T00:00:00.000Z',
    confirmedBy: 'user',
  });

  assert.equal(result.passed, true);
});

test('mission gate accepts a confirmed mission with observable deliverables', () => {
  const mission = {
    version: 1 as const,
    purpose: '理解某大型企业老系统当前的数据架构，为 replatform 提供依据。',
    expectedResult: '拿到当前 Data Source、Data Flow、Data Model，并形成 replatform 方案。',
    deliverables: inferMissionDeliverables(
      '理解某大型企业老系统当前的数据架构，为 replatform 提供依据。',
      '拿到当前 Data Source、Data Flow、Data Model，并形成 replatform 方案。',
    ),
    status: 'confirmed' as const,
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user' as const,
  };

  const result = evaluateMissionGate(mission);
  assert.equal(result.passed, true);
  assert.ok(result.draft.deliverableIds.includes('data-source'));
  assert.ok(result.draft.deliverableIds.includes('data-flow'));
  assert.ok(result.draft.deliverableIds.includes('data-model'));
  assert.ok(result.draft.deliverableIds.includes('target-architecture'));
});

test('deliverable inference stays conservative and falls back to a custom result', () => {
  const result = inferMissionDeliverables('研究一个系统', '给我一份结论');
  assert.deepEqual(result.map((item) => item.id), ['custom-result']);
});

test('Mission boundary blocks Workflow stages that are not part of the requested result', () => {
  const mission = {
    version: 1 as const,
    purpose: '理解某大型企业老系统当前的数据架构，为后续判断提供依据。',
    expectedResult: '只需要当前 Data Source、Data Flow 和 Data Model。',
    deliverables: inferMissionDeliverables(
      '理解某大型企业老系统当前的数据架构，为后续判断提供依据。',
      '只需要当前 Data Source、Data Flow 和 Data Model。',
    ),
    status: 'confirmed' as const,
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user' as const,
  };

  const currentState = isMissionWorkflowTargetAllowed(
    mission,
    'current-state',
    '梳理当前架构',
  );
  assert.equal(currentState.allowed, true);

  const target = isMissionWorkflowTargetAllowed(
    mission,
    'target',
    '设计新方案',
  );
  assert.equal(target.allowed, false);
  assert.match(target.reason ?? '', /目标架构/);
});

test('Mission boundary allows a target stage when the user explicitly requested target architecture', () => {
  const mission = {
    version: 1 as const,
    purpose: '分析旧系统并设计 replatform 方案。',
    expectedResult: '形成当前架构、目标架构、新旧映射和验证方案。',
    deliverables: inferMissionDeliverables(
      '分析旧系统并设计 replatform 方案。',
      '形成当前架构、目标架构、新旧映射和验证方案。',
    ),
    status: 'confirmed' as const,
    confirmedAt: '2026-10-05T00:00:00.000Z',
    confirmedBy: 'user' as const,
  };

  assert.equal(
    isMissionWorkflowTargetAllowed(mission, 'target', '设计新方案').allowed,
    true,
  );
});


test('specific current-state deliverables do not create a redundant umbrella deliverable', () => {
  const deliverables = inferMissionDeliverables(
    '理解当前系统的数据架构。',
    '只需要当前 Data Source、Data Flow 和 Data Model。',
  );

  assert.deepEqual(
    deliverables.map((item) => item.id),
    ['data-source', 'data-flow', 'data-model'],
  );
});
