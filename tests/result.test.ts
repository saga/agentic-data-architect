import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAgentCheckpoint, parseAgentAnswer } from '../src/agent/result.js';

test('agent checkpoint is parsed from structured output', () => {
  const raw = JSON.stringify({
    answer: '已完成第一阶段调查。',
    checkpoint: {
      title: 'Position 来源',
      summary: '已经确认 Position 的主要来源和批处理入口。',
      confirmed: ['PositionSnapshot 是主要输入表。'],
      evidenceIds: ['ev-1', 'ev-2'],
      unknowns: ['Market Value 的计算位置'],
      nextStep: '继续追踪 Market Value 的转换逻辑。',
    },
    claims: [],
    unknowns: ['Market Value 的计算位置'],
    followUpQuestions: [],
    routeOptions: [],
  });

  const checkpoint = extractAgentCheckpoint(raw);
  assert.ok(checkpoint);
  assert.equal(checkpoint.title, 'Position 来源');
  assert.equal(checkpoint.evidenceIds.length, 2);
});

test('checkpoint is optional and does not affect normal answer parsing', () => {
  const parsed = parseAgentAnswer(JSON.stringify({
    answer: '普通回答',
    claims: [],
    unknowns: [],
    followUpQuestions: [],
    routeOptions: [],
  }), new Set());

  assert.equal(parsed.answer, '普通回答');
  assert.equal(parsed.checkpoint, undefined);
});
