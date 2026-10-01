import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJourneyState,
  parseJourneyMarkdown,
  type JourneyFacts,
} from '../src/workflow/journey.js';

test('parses modernization markdown workflow and validates routes', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    '',
    'start -> intake',
    '',
    '## @task start',
    'title: Start',
    'visible: false',
    '- success -> intake',
    '',
    '## @task intake',
    'title: Intake',
    'objective: Define the goal.',
    'completeWhen: goal',
    '- success -> done',
    '',
    '## @end done',
    'visible: false',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(result.definition.id, 'demo');
  assert.equal(result.definition.start, 'intake');
  assert.equal(result.definition.nodes.length, 2);
  assert.equal(result.definition.nodes[0]?.completeWhen, 'goal');
});

test('rejects routes pointing to a missing node', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task start',
    'visible: false',
    '- success -> missing',
    '',
    '## @task intake',
    '- success -> done',
    '',
    '## @end done',
    'visible: false',
  ].join('\n'));

  assert.ok(result.issues.some((issue) => issue.includes('missing')));
});

test('journey state uses facts rather than agent self-report', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task start',
    'visible: false',
    '- success -> intake',
    '',
    '## @task intake',
    'title: 接到任务',
    'objective: 明确目标',
    'completeWhen: goal',
    '',
    '## @task estate',
    'title: 看清旧系统',
    'objective: 建立地图',
    'completeWhen: current-state',
    '',
    '## @task target',
    'title: 设计新方案',
    'objective: 形成草案',
    'completeWhen: target',
  ].join('\n'));

  assert.ok(result.definition);

  const facts: JourneyFacts = {
    goal: 'modernize proxy voting',
    currentState: null,
    unknowns: ['where is the source table?'],
    highGapKinds: ['discovery'],
    targetComponentCount: 0,
    mappingCount: 0,
    blockingValidationReady: 0,
    blockingValidationTotal: 0,
  };

  const state = buildJourneyState(result.definition!, facts);
  assert.deepEqual(state.completedNodeIds, ['intake']);
  assert.equal(state.currentNodeId, 'estate');
  assert.equal(state.stages.find((stage) => stage.id === 'estate')?.status, 'current');
  assert.equal(state.stages.find((stage) => stage.id === 'target')?.status, 'future');
});


test('parses the financial AI-native architecture workflow', () => {
  const result = parseJourneyMarkdown([
    '## @flow financial-ai-native-architecture',
    'start -> intake',
    '',
    '## @task intake',
    'title: 明确业务目标',
    'completeWhen: goal',
    '- success -> requirements',
    '- needs-input -> intake',
    '',
    '## @task requirements',
    'title: 明确业务需求',
    '- success -> data',
    '- needs-input -> intake',
    '',
    '## @task data',
    'title: 查数据',
    '- success -> domain-model',
    '- needs-input -> requirements',
    '',
    '## @task domain-model',
    'title: 定义金融业务模型',
    '- success -> architecture',
    '',
    '## @task architecture',
    'title: 设计数据架构',
    '- success -> semantic',
    '- retry -> data',
    '',
    '## @task semantic',
    'title: 设计业务语义',
    '- success -> agent',
    '',
    '## @task agent',
    'title: 设计 Agent',
    '- success -> controls',
    '',
    '## @task controls',
    'title: 设计安全和运行控制',
    '- success -> evaluation',
    '',
    '## @task evaluation',
    'title: 设计验证和评估',
    '- success -> roadmap',
    '',
    '## @task roadmap',
    'title: 形成实施路线',
    '- success -> done',
    '',
    '## @end done',
    'visible: false',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(result.definition?.id, 'financial-ai-native-architecture');
  assert.equal(result.definition?.start, 'intake');
  assert.equal(result.definition?.nodes.length, 10);
});
