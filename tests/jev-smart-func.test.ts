import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildJevSmartFuncResponseSchema,
  buildMissionActionPrompt,
  buildMissionAlignmentPrompt,
  buildMissionUnknownPrompt,
  normalizeMissionAction,
  normalizeMissionAlignment,
  normalizeUnknownImpact,
  type JevQuestion,
} from '../src/agent/jev-smart-func.js';

const questions: Record<string, JevQuestion> = {
  route: {
    type: 'choice',
    instructions: '判断当前问题最适合走哪条调查路线。',
    options: {
      current_state: '只分析现状。',
      modernization: '设计新架构。',
      other: '以上都不适合。',
    },
  },
  risk: {
    type: 'score',
    instructions: '判断这件事的风险等级。',
    levels: [
      { name: 'low', description: '低风险。' },
      { name: 'medium', description: '中风险。' },
      { name: 'high', description: '高风险。' },
    ],
  },
  needs_human: {
    type: 'noul',
    instructions: '这项操作是否明确需要人工决策？',
    criteria: {
      true: '涉及用户必须做出的业务选择。',
      false: 'Agent 可以基于已有信息自行继续。',
    },
  },
};

test('builds one structured-output schema for mixed decision questions', () => {
  const schema = buildJevSmartFuncResponseSchema(questions);

  const parsed = schema.parse({
    route: {
      type: 'choice',
      choice: 'modernization',
      probabilities: [
        { key: 'current_state', probability: 0.1 },
        { key: 'modernization', probability: 0.8 },
        { key: 'other', probability: 0.1 },
      ],
      confidence: 0.9,
    },
    risk: {
      type: 'score',
      score: 1.7,
      probabilities: [
        { level: 'low', probability: 0.1 },
        { level: 'medium', probability: 0.7 },
        { level: 'high', probability: 0.2 },
      ],
      confidence: 0.8,
    },
    needs_human: {
      type: 'noul',
      noul: 0.93,
    },
  });

  assert.equal(parsed.route.type, 'choice');
  assert.equal(parsed.risk.type, 'score');
  assert.equal(parsed.needs_human.type, 'noul');
});

test('uses a closed answer schema and rejects unknown question keys', () => {
  const schema = buildJevSmartFuncResponseSchema({
    decision: {
      type: 'noul',
      instructions: '是否应该继续？',
    },
  });

  assert.throws(
    () => schema.parse({
      decision: { type: 'noul', noul: 0.8 },
      extra: { type: 'noul', noul: 0.1 },
    }),
  );
});

test('validates question keys before creating a schema', () => {
  assert.throws(
    () => buildJevSmartFuncResponseSchema({
      'not valid': {
        type: 'noul',
        instructions: '是否继续？',
      },
    }),
    /question key 不合法/,
  );
});


test('Mission Alignment distinguishes relevance from whether more work is worthwhile', () => {
  const mission = {
    purpose: '理解 IBM 老系统，为 replatform 决策提供依据。',
    expectedResult: '形成当前数据来源、数据流和数据模型。',
    deliverables: [
      { id: 'data-source', title: 'Data Source', description: '关键数据来源。', required: true },
      { id: 'data-flow', title: 'Data Flow', description: '关键数据流向。', required: true },
      { id: 'data-model', title: 'Data Model', description: '核心数据模型。', required: true },
    ],
  };

  const prompt = buildMissionAlignmentPrompt({
    mission,
    candidate: '找到 Position 的来源表和主链路。',
    context: { progress: '1/3', newEvidenceIds: ['ev-2'] },
  });
  assert.match(prompt, /Mission/);
  assert.match(prompt, /aligned=true/);
  assert.match(prompt, /worth_continuing=true/);
  assert.match(prompt, /找到 Position 的来源表/);

  const result = normalizeMissionAlignment({
    aligned: { type: 'noul', noul: 0.9 },
    worth_continuing: { type: 'noul', noul: 0.8 },
  });
  assert.equal(result.aligned, true);
  assert.equal(result.worthContinuing, true);
  assert.ok(result.alignment > result.continuationValue - 0.2);
});

test('Mission Alignment stops once the Mission is sufficiently supported', () => {
  const result = normalizeMissionAlignment({
    aligned: { type: 'noul', noul: 0.93 },
    worth_continuing: { type: 'noul', noul: 0.2 },
  });
  assert.equal(result.aligned, true);
  assert.equal(result.worthContinuing, false);
  assert.match(result.reason, /没有必要/);
});


test('Mission Action requires both direct Mission alignment and current necessity', () => {
  const mission = {
    purpose: '理解 IBM 老系统，为 replatform 决策提供依据。',
    expectedResult: '形成当前 Data Source、Data Flow、Data Model。',
    deliverables: [
      { id: 'data-source', title: 'Data Source', description: '关键数据来源。', required: true },
      { id: 'data-flow', title: 'Data Flow', description: '关键数据流向。', required: true },
      { id: 'data-model', title: 'Data Model', description: '核心数据模型。', required: true },
    ],
  };

  const prompt = buildMissionActionPrompt({
    mission,
    candidate: {
      toolName: 'grep',
      toolArgs: { pattern: 'Position', path: 'src' },
    },
    context: { progress: '1/3' },
  });
  assert.match(prompt, /现在不做这个动作/);
  assert.match(prompt, /Data Source/);

  const allowed = normalizeMissionAction({
    aligned: { type: 'noul', noul: 0.95 },
    necessary: { type: 'noul', noul: 0.9 },
    target_deliverable: {
      type: 'choice',
      choice: 'data-source',
      probabilities: [{ key: 'data-source', probability: 1 }],
      confidence: 0.9,
    },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.targetDeliverableId, 'data-source');

  const denied = normalizeMissionAction({
    aligned: { type: 'noul', noul: 0.95 },
    necessary: { type: 'noul', noul: 0.2 },
    target_deliverable: {
      type: 'choice',
      choice: 'data-source',
      probabilities: [{ key: 'data-source', probability: 1 }],
      confidence: 0.9,
    },
  });
  assert.equal(denied.allowed, false);
});

test('Unknown impact deterministically routes to ignore, investigate, or ask_user', () => {
  const ignore = normalizeUnknownImpact('历史接口命名风格还不统一。', {
    affects_mission: { type: 'noul', noul: 0.2 },
    worth_investigating: { type: 'noul', noul: 0.95 },
    can_agent_resolve: { type: 'noul', noul: 0.9 },
  });
  assert.equal(ignore.action, 'ignore');

  const investigate = normalizeUnknownImpact('Position 的历史回补 SQL 还没找到。', {
    affects_mission: { type: 'noul', noul: 0.95 },
    worth_investigating: { type: 'noul', noul: 0.9 },
    can_agent_resolve: { type: 'noul', noul: 0.95 },
  });
  assert.equal(investigate.action, 'investigate');

  const askUser = normalizeUnknownImpact('业务方是否允许历史仓位回补需要确认。', {
    affects_mission: { type: 'noul', noul: 0.95 },
    worth_investigating: { type: 'noul', noul: 0.9 },
    can_agent_resolve: { type: 'noul', noul: 0.1 },
  });
  assert.equal(askUser.action, 'ask_user');

  const prompt = buildMissionUnknownPrompt({
    mission: {
      purpose: '理解旧系统，为迁移决策提供依据。',
      expectedResult: '形成可靠的当前状态说明。',
      deliverables: [{
        id: 'current-state',
        title: '当前状态',
        description: '关键系统、数据流和模型。',
        required: true,
      }],
    },
    unknowns: ['某个事实还没有确认。'],
  });
  assert.match(prompt, /affects_mission=true/);
  assert.match(prompt, /can_agent_resolve=true/);
});
