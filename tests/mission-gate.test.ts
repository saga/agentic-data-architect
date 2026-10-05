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
  assert.match(formatMissionGateFailure(result), /任务目的/);
});

test('mission gate rejects a persisted contract whose deliverables no longer match its text', () => {
  const purpose = '理解 IBM 老系统当前的数据架构，为 replatform 提供依据。';
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

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === '交付物与任务契约一致' && !item.passed));
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
