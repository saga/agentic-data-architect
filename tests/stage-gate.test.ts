import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStageCheckpoint,
  evaluateInvestigationStageGate,
  type StageGateInput,
} from '../src/workflow/stage-gate.js';

function input(overrides: Partial<StageGateInput> = {}): StageGateInput {
  return {
    execution: 0,
    mission: {
      version: 1,
      purpose: '理解旧系统，为迁移决策提供依据。',
      expectedResult: '形成当前数据来源、数据流和数据模型的可靠说明。',
      deliverables: [
        { id: 'data-source', title: 'Data Source', description: '说明关键数据来源。', required: true },
        { id: 'data-flow', title: 'Data Flow', description: '说明关键数据流向。', required: true },
        { id: 'data-model', title: 'Data Model', description: '说明核心数据模型。', required: true },
      ],
      status: 'confirmed',
      confirmedAt: '2026-10-05T00:00:00.000Z',
      confirmedBy: 'user',
    },
    before: {
      evidenceIds: ['ev-old'],
      findingIds: ['finding-old'],
      discoveryRunCount: 1,
    },
    after: {
      evidenceIds: ['ev-old', 'ev-new'],
      findingIds: ['finding-old'],
      discoveryRunCount: 1,
    },
    missionProgressBefore: {
      covered: 0,
      total: 3,
      percent: 0,
      deliverables: [
        { id: 'data-source', title: 'Data Source', description: '说明关键数据来源。', required: true, status: 'not_started', detail: '未开始' },
        { id: 'data-flow', title: 'Data Flow', description: '说明关键数据流向。', required: true, status: 'not_started', detail: '未开始' },
        { id: 'data-model', title: 'Data Model', description: '说明核心数据模型。', required: true, status: 'not_started', detail: '未开始' },
      ],
    },
    missionProgressAfter: {
      covered: 1,
      total: 3,
      percent: 33,
      deliverables: [
        { id: 'data-source', title: 'Data Source', description: '说明关键数据来源。', required: true, status: 'covered', detail: '已发现数据集' },
        { id: 'data-flow', title: 'Data Flow', description: '说明关键数据流向。', required: true, status: 'in_progress', detail: 'Flow 已开始' },
        { id: 'data-model', title: 'Data Model', description: '说明核心数据模型。', required: true, status: 'not_started', detail: '未开始' },
      ],
    },
    parsed: {
      answer: '已经查清 Position 的主要来源。',
      claims: [
        {
          claim: 'Position 的主要来源是订单库。',
          status: 'inferred',
          evidenceIds: ['ev-new'],
        },
      ],
      unknowns: ['历史回补流程还没有确认。'],
      followUpQuestions: ['继续核对历史回补 SQL。'],
      routeOptions: [],
    },
    ...overrides,
  };
}

test('stage gate passes from actual evidence-backed work', () => {
  const result = evaluateInvestigationStageGate(input());

  assert.equal(result.passed, true);
  assert.equal(result.newEvidenceIds[0], 'ev-new');
  assert.equal(result.evidenceBackedClaimCount, 1);
  assert.equal(result.shouldContinue, true);
});

test('Stage Gate rejects real but Mission-unrelated work when Smart Alignment says it is unrelated', () => {
  const result = evaluateInvestigationStageGate(input({
    missionAlignment: {
      aligned: false,
      alignment: 0.2,
      worthContinuing: true,
      continuationValue: 0.9,
      reason: '本轮主要在追逐无关的历史细节。',
    },
  }));

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === '阶段成果与 Mission 对齐' && !item.passed));
});

test('Stage Gate uses deterministic open deliverables before Smart continuation advice', () => {
  const result = evaluateInvestigationStageGate(input({
    missionAlignment: {
      aligned: true,
      alignment: 0.9,
      worthContinuing: false,
      continuationValue: 0.1,
      reason: '本阶段有效，但剩余结果仍未覆盖。',
    },
  }));

  assert.equal(result.passed, true);
  assert.equal(result.shouldContinue, true);
});

test('Stage Gate can stop auto-continuation when required deliverables are covered and Smart says stop', () => {
  const base = input();
  const result = evaluateInvestigationStageGate({
    ...base,
    missionProgressAfter: {
      covered: 3,
      total: 3,
      percent: 100,
      deliverables: base.missionProgressBefore.deliverables.map((item) => ({
        ...item,
        status: 'covered' as const,
        detail: '已覆盖',
      })),
    },
    missionAlignment: {
      aligned: true,
      alignment: 0.95,
      worthContinuing: false,
      continuationValue: 0.1,
      reason: 'Mission 已经得到足够支持。',
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.shouldContinue, false);
});

test('a polished answer alone cannot pass the stage gate', () => {
  const result = evaluateInvestigationStageGate(input({
    after: {
      evidenceIds: ['ev-old'],
      findingIds: ['finding-old'],
      discoveryRunCount: 1,
    },
    parsed: {
      answer: '已经完成了一轮完整分析，并给出了清晰结论。',
      claims: [],
      unknowns: [],
      followUpQuestions: [],
      routeOptions: [],
    },
  }));

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === '本阶段存在真实调查成果' && !item.passed));
});

test('invalid evidence references block the stage gate', () => {
  const result = evaluateInvestigationStageGate(input({
    parsed: {
      answer: '找到了一条结论。',
      claims: [
        {
          claim: '这个结论引用了不存在的 Evidence。',
          status: 'inferred',
          evidenceIds: ['missing'],
        },
      ],
      unknowns: [],
      followUpQuestions: [],
      routeOptions: [],
    },
    after: {
      evidenceIds: ['ev-old'],
      findingIds: ['finding-old'],
      discoveryRunCount: 1,
    },
    missionProgressAfter: {
      covered: 0,
      total: 3,
      percent: 0,
      deliverables: input().missionProgressBefore.deliverables,
    },
  }));

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === 'Claim 的 Evidence 引用有效' && !item.passed));
});

test('persisted structured work product can form a checkpoint without new evidence', () => {
  const base = input({
    after: {
      evidenceIds: ['ev-old'],
      findingIds: ['finding-old'],
      discoveryRunCount: 1,
    },
    missionProgressAfter: {
      covered: 2,
      total: 3,
      percent: 67,
      deliverables: input().missionProgressBefore.deliverables.map((item, index) => ({
        ...item,
        status: index < 2 ? 'covered' as const : 'not_started' as const,
        detail: index < 2 ? '已覆盖' : '未开始',
      })),
    },
    parsed: {
      answer: '目标架构与新旧对应关系已经形成。',
      claims: [],
      unknowns: [],
      followUpQuestions: [],
      routeOptions: [],
    },
    persistedWorkProductChanged: true,
  });
  const result = evaluateInvestigationStageGate(base);
  assert.equal(result.passed, true);
  assert.equal(result.checks.some((item) => item.name === '本阶段存在真实调查成果' && item.passed), true);
});

test('a later real stage can still leave a checkpoint after earlier deliverables are already covered', () => {
  const base = input({
    execution: 1,
    before: {
      evidenceIds: ['ev-old'],
      findingIds: ['finding-old'],
      discoveryRunCount: 2,
    },
    after: {
      evidenceIds: ['ev-old', 'ev-next'],
      findingIds: ['finding-old'],
      discoveryRunCount: 2,
    },
    missionProgressBefore: {
      covered: 3,
      total: 3,
      percent: 100,
      deliverables: input().missionProgressBefore.deliverables.map((item) => ({
        ...item,
        status: 'covered' as const,
        detail: '已覆盖',
      })),
    },
    missionProgressAfter: {
      covered: 3,
      total: 3,
      percent: 100,
      deliverables: input().missionProgressBefore.deliverables.map((item) => ({
        ...item,
        status: 'covered' as const,
        detail: '已覆盖',
      })),
    },
  });
  const result = evaluateInvestigationStageGate(base);
  assert.equal(result.passed, true);
  assert.equal(result.shouldContinue, false);
});

test('checkpoint can only be built after the gate passes', () => {
  const gateInput = input({ execution: 2 });
  const gate = evaluateInvestigationStageGate(gateInput);
  const checkpoint = buildStageCheckpoint(gateInput, gate);

  assert.equal(checkpoint.title, '第 3 阶段');
  assert.equal(checkpoint.evidenceIds.includes('ev-new'), true);

  assert.throws(
    () => buildStageCheckpoint(
      input({
        after: {
          evidenceIds: ['ev-old'],
          findingIds: ['finding-old'],
          discoveryRunCount: 1,
        },
        missionProgressAfter: {
          covered: 0,
          total: 3,
          percent: 0,
          deliverables: input().missionProgressBefore.deliverables,
        },
        parsed: {
          answer: '只是写了一段漂亮总结。',
          claims: [],
          unknowns: [],
          followUpQuestions: [],
          routeOptions: [],
        },
      }),
      evaluateInvestigationStageGate(input({
        after: {
          evidenceIds: ['ev-old'],
          findingIds: ['finding-old'],
          discoveryRunCount: 1,
        },
        parsed: {
          answer: '只是写了一段漂亮总结。',
          claims: [],
          unknowns: [],
          followUpQuestions: [],
          routeOptions: [],
        },
      })),
    ),
    /Stage Gate 未通过/,
  );
});


test('unrelated investigation changes do not create a stage summary', () => {
  const base = input();
  const result = evaluateInvestigationStageGate({
    ...base,
    after: {
      evidenceIds: ['ev-old', 'ev-unrelated'],
      findingIds: ['finding-old'],
      discoveryRunCount: 2,
    },
    missionProgressBefore: base.missionProgressBefore,
    missionProgressAfter: base.missionProgressBefore,
    parsed: {
      answer: '找到了一些额外资料，但这些资料不改变本次任务要交付的结果。',
      claims: [],
      unknowns: ['额外的历史细节还不清楚。'],
      followUpQuestions: [],
      routeOptions: [],
    },
  });

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === '本阶段推进了 Mission 交付物' && !item.passed));
});
