import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgentAnswer } from '../src/agent/result.js';

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
