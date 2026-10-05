import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMissionContractPrompt, buildQuestionPrompt } from '../src/agent/prompts.js';

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