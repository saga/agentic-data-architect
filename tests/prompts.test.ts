import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAssistantAnswerPrompt, buildAssistantSoulPrompt, buildMissionContractPrompt, buildQuestionPrompt, LEAD_SYSTEM_PROMPT } from '../src/agent/prompts.js';

const mission = {
  purpose: '理解老系统当前的数据架构，为后续迁移判断提供依据。',
  expectedResult: '拿到当前 Data Source、Data Flow、Data Model，不设计新架构。',
  deliverables: [
    { id: 'data-source', title: 'Data Source', description: '关键数据从哪里来。', required: true },
    { id: 'data-flow', title: 'Data Flow', description: '数据如何流动。', required: true },
    { id: 'data-model', title: 'Data Model', description: '数据如何组织。', required: true },
  ],
};

test('Mission prompt puts purpose and expected result before execution context', () => {
  const prompt = buildMissionContractPrompt(mission);

  assert.equal(prompt.indexOf('## 最高优先级：本次任务 Mission'), 0);
  assert.ok(prompt.indexOf('理解老系统当前的数据架构') < prompt.indexOf('### 必须关注的交付物'));
  assert.ok(prompt.indexOf('拿到当前 Data Source、Data Flow、Data Model') < prompt.indexOf('### 必须关注的交付物'));
});

test('question prompt starts from Mission and treats the user question as execution context', () => {
  const prompt = buildQuestionPrompt({
    investigationName: 'demo',
    mission,
    missionProgress: {
      covered: 1,
      total: 3,
      percent: 33,
      deliverables: mission.deliverables.map((item, index) => ({
        ...item,
        status: index === 0 ? 'covered' : 'not_started',
        detail: index === 0 ? '已经形成。' : '还没有形成。',
      })),
    },
    goal: mission.purpose,
    scope: ['IBM legacy system'],
    systems: ['IBM'],
    question: '继续看看某张表',
    contextText: '',
    evidenceIds: [],
    unknowns: ['某个字段定义不清楚'],
  });

  assert.equal(prompt.indexOf('## 最高优先级：本次任务 Mission'), 0);
  assert.ok(prompt.indexOf('当前执行请求：继续看看某张表') > prompt.indexOf('## 最高优先级：本次任务 Mission'));
  assert.match(prompt, /当前执行请求把 Mission 改写/);
});

test('Assistant Soul is isolated to final answer rendering', () => {
  const soul = buildAssistantSoulPrompt('自然、直接、长期合作感。');
  const prompt = buildAssistantAnswerPrompt(
    '自然、直接、长期合作感。',
    'Global 配置作为默认值，Task 只保存显式 override。',
    [{ category: 'working_style', key: 'response_style', value: '回答直接、少套话。' }],
  );

  assert.match(soul, /怎么和用户相处/);
  assert.match(soul, /严禁参与事实判断/);
  assert.match(prompt, /不得新增、删除、合并或改变任何事实/);
  assert.match(prompt, /Relationship Memory/);
  assert.match(prompt, /回答直接、少套话/);
  assert.match(prompt, /Global 配置作为默认值/);
  assert.match(prompt, /最终文本直接展示给用户/);
  assert.match(prompt, /不要加角色名或标题/);
  assert.doesNotMatch(LEAD_SYSTEM_PROMPT, /Assistant Soul|Relationship Memory|长期人格/);
  assert.match(LEAD_SYSTEM_PROMPT, /answer 是直接给用户看的最终结果/);
  assert.doesNotMatch(LEAD_SYSTEM_PROMPT, /answer 是“秘书向用户汇报/);
  assert.match(LEAD_SYSTEM_PROMPT, /不要用“秘书”“助手”作为回答标题/);
});
