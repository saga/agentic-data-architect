import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionPrompt } from '../src/agent/prompts.js';

test('selected guidance is treated as an approved execution action', () => {
  const prompt = buildQuestionPrompt({
    investigationName: 'test-investigation',
    goal: '理解旧系统关键数据流',
    scope: ['代码'],
    question: '查这些关键数据如何被使用',
    contextText: 'CUSTOMER、CATEGORY 与 CREDIT_INFO 出现在 SQL 脚本中。',
    evidenceIds: [],
    unknowns: ['哪些 Java 服务和 REST 接口读写这些表？'],
    selectedGuidance: '查 Java 实体、Service 和 REST 接口如何读写这些表',
  });

  assert.match(prompt, /继续调查/);
  assert.match(prompt, /已经代表用户同意执行该调查动作/);
  assert.match(prompt, /请直接执行这个动作/);
  assert.doesNotMatch(prompt, /把待回答的问题塞进 followUpQuestions/);
});

test('follow-up guidance is explicitly defined as an executable action', () => {
  const prompt = buildQuestionPrompt({
    investigationName: 'test-investigation',
    goal: '理解旧系统',
    scope: ['代码'],
    question: '继续',
    contextText: '',
    evidenceIds: [],
    unknowns: [],
  });

  assert.match(prompt, /继续调查.*可点击动作/);
  assert.match(prompt, /真正需要用户做选择时，使用 ask_user/);
});
