import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentAnswer } from '../src/agent/result.js';

test('checkpoint is optional and does not affect normal answer parsing', () => {
  const parsed = parseAgentAnswer(JSON.stringify({
    answer: '普通回答',
    claims: [],
    unknowns: [],
    followUpQuestions: [],
    routeOptions: [],
  }), new Set());

  assert.equal(parsed.answer, '普通回答');
  assert.equal(parsed.answer, '普通回答');
});
