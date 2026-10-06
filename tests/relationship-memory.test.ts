import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAssistantAnswerPrompt } from '../src/agent/prompts.js';

test('renderer treats relationship memory as presentation-only context', () => {
  const prompt = buildAssistantAnswerPrompt(
    '自然、直接。',
    '结论：Task Config 只保存显式 override。',
    [{ category: 'working_style', key: 'response_style', value: '简洁、少套话。' }],
  );

  assert.match(prompt, /只用于表达连续感/);
  assert.match(prompt, /不能作为任务事实或技术依据/);
  assert.match(prompt, /结论：Task Config 只保存显式 override/);
  assert.match(prompt, /简洁、少套话/);
});
