import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestionPrompt } from '../src/agent/prompts.js';

test('selected guidance is treated as an approved execution action', () => {
  const prompt = buildQuestionPrompt({
    investigationName: 'test-investigation',
    mission: {
      purpose: '理解旧系统关键数据流，为后续架构工作提供依据。',
      expectedResult: '形成关键数据来源、数据流和核心数据模型的可靠说明。',
      deliverables: [
        { id: 'data-source', title: 'Data Source', description: '说明关键数据来源。', required: true },
        { id: 'data-flow', title: 'Data Flow', description: '说明关键数据流向。', required: true },
        { id: 'data-model', title: 'Data Model', description: '说明核心数据模型。', required: true },
      ],
    },
    goal: '理解旧系统关键数据流',
    scope: ['代码'],
    systems: ['旧系统'],
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
