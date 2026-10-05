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
  }));

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === 'Claim 的 Evidence 引用有效' && !item.passed));
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
