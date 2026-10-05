import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMissionDraft,
  evaluateMissionGate,
  formatMissionGateFailure,
  inferMissionDeliverables,
  isMissionWorkflowTargetAllowed,
} from '../src/workflow/mission-gate.js';

test('mission gate requires explicit user confirmation', () => {
  const result = evaluateMissionGate(undefined);

  assert.equal(result.passed, false);
  assert.match(formatMissionGateFailure(result), /为什么要做.*最后希望拿到什么/);
});

test('mission gate accepts a confirmed mission with observable deliverables', () => {
  const mission = {
    version: 1 as const,
    purpose: '理解 IBM 老系统当前的数据架构，为 replatform 提供依据。',
    expectedResult: '拿到当前 Data Source、Data Flow、Data Model，并形成 replatform 方案。',
    deliverables: inferMissionDeliverables(
      '理解 IBM 老系统当前的数据架构，为 replatform 提供依据。',
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

test('mission draft does not imply confirmation', () => {
  const draft = buildMissionDraft('分析当前系统的数据架构');
  assert.equal(draft.expectedResult, '');
  assert.deepEqual(draft.deliverableIds, []);
});


test('Mission boundary blocks Workflow stages that are not part of the requested result', () => {
  const mission = {
    version: 1 as const,
    purpose: '理解 IBM 老系统当前的数据架构，为后续判断提供依据。',
    expectedResult: '只需要当前 Data Source、Data Flow 和 Data Model。',
    deliverables: inferMissionDeliverables(
      '理解 IBM 老系统当前的数据架构，为后续判断提供依据。',
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
