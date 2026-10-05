import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCheckpoint, parseAgentAnswer } from '../src/agent/result.js';

test('does not fall back to raw structured JSON when workflow is empty', () => {
  const raw = JSON.stringify({
    answer: '目前无法确定 Position 的最终来源。',
    claims: [
      {
        claim: 'Position 最终来自哪个系统或表，目前无法确定。',
        status: 'unknown',
        evidenceIds: [],
      },
    ],
    unknowns: ['生成 Position 的 SQL 或 dbt 模型指向哪些上游表和系统？'],
    followUpQuestions: ['请提供包含 Position 生成逻辑的仓库地址或本机目录路径。'],
    routeOptions: [],
    workflow: {
      nodeId: '',
      outcome: '',
    },
  });

  const parsed = parseAgentAnswer(raw, new Set());

  assert.equal(parsed.answer, '目前无法确定 Position 的最终来源。');
  assert.deepEqual(parsed.claims.map((claim) => claim.claim), [
    'Position 最终来自哪个系统或表，目前无法确定。',
  ]);
  assert.equal(parsed.workflow, undefined);
});


test('parses and sanitizes structured investigation intake', () => {
  const raw = JSON.stringify({
    answer: '已经从用户问题和仓库资料整理出范围。',
    intake: {
      goal: '替换老的投票工作流',
      scope: ['Proxy Voting'],
      systems: ['ISS Portal'],
      source: 'mixed',
      userConfirmed: true,
      evidenceIds: ['ev-001', 'missing'],
    },
    claims: [],
    unknowns: [],
    followUpQuestions: [],
    routeOptions: [],
  });

  const parsed = parseAgentAnswer(raw, new Set(['ev-001']));
  assert.deepEqual(parsed.intake, {
    goal: '替换老的投票工作流',
    scope: ['Proxy Voting'],
    systems: ['ISS Portal'],
    source: 'mixed',
    userConfirmed: true,
    evidenceIds: ['ev-001'],
  });
  assert.ok(parsed.warnings.some((warning) => warning.includes('调查范围引用了不存在的 Evidence')));
});


test('builds a fallback checkpoint from substantive stage results when model omits checkpoint', () => {
  const raw = JSON.stringify({
    answer: '已经查清 Position 的主要来源和转换路径，并确认订单库是当前主来源。\n\n下一阶段可以继续核对下游报表。',
    claims: [
      {
        claim: 'Position 的主要来源是订单库。',
        status: 'supported',
        evidenceIds: ['ev-001'],
      },
      {
        claim: '下游报表继续使用该 Position 结果。',
        status: 'inferred',
        evidenceIds: ['ev-002'],
      },
    ],
    unknowns: ['还没有确认历史回补流程。'],
    followUpQuestions: ['继续核对历史回补 SQL。'],
    routeOptions: [],
  });

  const parsed = parseAgentAnswer(raw, new Set(['ev-001', 'ev-002']));
  const checkpoint = buildAgentCheckpoint(parsed, 1);

  assert.ok(checkpoint);
  assert.equal(checkpoint.title, '第 2 阶段');
  assert.match(checkpoint.summary, /已经查清 Position/);
  assert.deepEqual(checkpoint.confirmed, ['Position 的主要来源是订单库。']);
  assert.deepEqual(checkpoint.evidenceIds, ['ev-001', 'ev-002']);
  assert.deepEqual(checkpoint.unknowns, ['还没有确认历史回补流程。']);
  assert.equal(checkpoint.nextStep, '继续核对历史回补 SQL。');
});
