import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMissionContractPrompt, buildQuestionPrompt } from '../src/agent/prompts.js';

const mission = {
  purpose: '理解 IBM 老系统，为 replatform 决策提供依据。',
  expectedResult: '形成当前 Data Source、Data Flow、Data Model，并给出 replatform 方案。',
  deliverables: [
    { id: 'data-source', title: 'Data Source', description: '说明关键数据来源。', required: true },
    { id: 'data-flow', title: 'Data Flow', description: '说明关键数据流向。', required: true },
    { id: 'data-model', title: 'Data Model', description: '说明核心数据模型。', required: true },
  ],
};

test('Mission Contract is rendered as the highest-priority prompt block', () => {
  const prompt = buildMissionContractPrompt(mission);
  assert.equal(prompt.startsWith('## 最高优先级：本次任务 Mission'), true);
  assert.ok(prompt.indexOf('任务目的：为什么做') < prompt.indexOf('期望结果：最后要拿到什么'));
  assert.match(prompt, /Data Source/);
  assert.match(prompt, /Data Flow/);
  assert.match(prompt, /Data Model/);
});

test('question prompt repeats Mission before question-specific context', () => {
  const prompt = buildQuestionPrompt({
    investigationName: 'ibm',
    mission,
    goal: mission.purpose,
    scope: ['Position'],
    systems: ['IBM legacy'],
    question: '继续查某张表',
    contextText: 'Evidence context',
    evidenceIds: ['ev-1'],
    unknowns: ['某个字段含义'],
  });

  assert.equal(prompt.startsWith('## Mission Contract（本轮最高优先级）'), true);
  assert.ok(prompt.indexOf('期望结果：') < prompt.indexOf('当前未知项'));
  assert.ok(prompt.indexOf('当前未知项') < prompt.indexOf('当前执行请求：'));
});
