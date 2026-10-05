import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMissionDraft,
  evaluateMissionGate,
  formatMissionGateFailure,
  inferMissionDeliverables,
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
