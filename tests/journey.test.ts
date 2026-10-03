import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJourneyTransition,
  buildJourneyState,
  initialJourneyExecution,
  loadWorkflowJourney,
  parseJourneyMarkdown,
  validateJourneyDefinition,
  type JourneyFacts,
} from '../src/workflow/journey.js';

const baseFacts: JourneyFacts = {
  goal: 'modernize proxy voting',
  currentState: null,
  unknowns: ['where is the source table?'],
  highGapKinds: ['discovery'],
  targetComponentCount: 0,
  mappingCount: 0,
  blockingValidationReady: 0,
  blockingValidationTotal: 0,
};

test('parses workflow branches and completion mode', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
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
    'completion: deterministic',
    '- success -> estate',
    '- needs-input -> intake',
    '',
    '## @task estate',
    'title: Estate',
    'completion: agent',
    '- success -> done',
    '',
    '## @end done',
    'visible: false',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(result.definition?.start, 'intake');
  assert.equal(result.definition?.nodes.find((node) => node.id === 'intake')?.completion, 'deterministic');
  assert.deepEqual(
    result.definition?.nodes.find((node) => node.id === 'intake')?.routes.map((route) => route.outcome),
    ['success', 'needs-input'],
  );
});

test('rejects dangling nodes and dead-end nodes', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'completion: agent',
    '- success -> missing',
    '',
    '## @task orphan',
    'completion: agent',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.issues.some((issue) => issue.includes('missing')));
  assert.ok(result.issues.some((issue) => issue.includes('orphan')));
});

test('allows a retry cycle when the graph still has an exit to done', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> check',
    '',
    '## @task check',
    'completion: agent',
    '- retry -> check',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(validateJourneyDefinition(result.definition!).length, 0);
});

test('journey state follows execution and facts, not node array order', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'title: 接到任务',
    'objective: 明确目标',
    'completeWhen: goal',
    'completion: deterministic',
    '- success -> investigate',
    '',
    '## @task investigate',
    'title: 查关键问题',
    'completion: agent',
    '- success -> target',
    '- needs-input -> investigate',
    '',
    '## @task target',
    'title: 设计方案',
    'completion: agent',
    '- success -> done',
    '',
    '## @end done',
    'visible: false',
  ].join('\n'));

  assert.ok(result.definition);
  const initial = initialJourneyExecution(result.definition!);
  const state = buildJourneyState(result.definition!, baseFacts, initial);

  assert.deepEqual(state.completedNodeIds, ['intake']);
  assert.equal(state.currentNodeId, 'investigate');
  assert.equal(state.stages.find((stage) => stage.id === 'investigate')?.status, 'current');
  assert.equal(state.stages.find((stage) => stage.id === 'target')?.status, 'future');
});

test('applies only an actual outgoing workflow outcome', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> investigate',
    '',
    '## @task investigate',
    'completion: agent',
    '- success -> target',
    '- retry -> investigate',
    '',
    '## @task target',
    'completion: agent',
    '- success -> done',
    '',
    '## @end done',
    'visible: false',
  ].join('\n'));

  assert.ok(result.definition);
  const initial = initialJourneyExecution(result.definition!);

  assert.throws(
    () => applyJourneyTransition(result.definition!, initial, 'investigate', 'invented'),
    /outcome=invented/,
  );

  const retry = applyJourneyTransition(result.definition!, initial, 'investigate', 'retry');
  assert.equal(retry.currentNodeId, 'investigate');
  assert.deepEqual(retry.completedNodeIds, []);

  const success = applyJourneyTransition(result.definition!, initial, 'investigate', 'success');
  assert.equal(success.currentNodeId, 'target');
  assert.deepEqual(success.completedNodeIds, ['investigate']);
});

test('loads the architecture assessment markdown workflow', async () => {
  const definition = await loadWorkflowJourney('data-architecture-assessment');
  assert.equal(definition.id, 'data-architecture-assessment');
  assert.equal(definition.start, 'intake');
  assert.equal(definition.nodes.find((node) => node.id === 'intake')?.completion, 'deterministic');
});
