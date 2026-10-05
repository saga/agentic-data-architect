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

test('parses the minimal workflow DSL', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'title: Intake',
    'objective: Define the goal.',
    'completeWhen: goal',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(result.definition?.start, 'intake');
  assert.equal(result.definition?.nodes.find((node) => node.id === 'intake')?.completeWhen, 'goal');
  assert.equal(result.definition?.nodes.find((node) => node.id === 'intake')?.actor, 'agent');
});

test('rejects dangling nodes and dead-end nodes', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    '- success -> missing',
    '',
    '## @task orphan',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.issues.some((issue) => issue.includes('missing')));
  assert.ok(result.issues.some((issue) => issue.includes('orphan')));
});

test('deterministic retry self-loop does not mark the node completed', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> check',
    '',
    '## @task check',
    'completeWhen: goal',
    '- retry -> check',
  ].join('\n'));

  assert.ok(result.definition);
  const state = buildJourneyState(
    result.definition!,
    baseFacts,
    initialJourneyExecution(result.definition!),
  );
  assert.equal(state.execution.currentNodeId, 'check');
  assert.deepEqual(state.execution.completedNodeIds, []);
});

test('allows a retry cycle when the graph still has an exit to done', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> check',
    '',
    '## @task check',
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
    '- success -> investigate',
    '',
    '## @task investigate',
    'title: 查关键问题',
    '- success -> target',
    '',
    '## @task target',
    'title: 设计方案',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);
  const initial = initialJourneyExecution(result.definition!);
  const state = buildJourneyState(result.definition!, baseFacts, initial);

  assert.deepEqual(state.execution.completedNodeIds, ['intake']);
  assert.equal(state.execution.currentNodeId, 'investigate');
  assert.equal(state.stages.find((stage) => stage.id === 'investigate')?.status, 'current');
  assert.equal(state.stages.find((stage) => stage.id === 'target')?.status, 'future');
});

test('applies only an actual outgoing workflow outcome', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> investigate',
    '',
    '## @task investigate',
    '- success -> target',
    '- retry -> investigate',
    '',
    '## @task target',
    '- success -> done',
    '',
    '## @end done',
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

test('human review starts in waiting state', () => {
  const result = parseJourneyMarkdown(['## @flow demo','start -> review','','## @review review','actor: human','- approved -> done','','## @end done'].join('\n'));
  assert.ok(result.definition);
  const execution = initialJourneyExecution(result.definition!, 1);
  assert.equal(execution.status, 'waiting');
  assert.equal(execution.pendingInteraction?.nodeId, 'review');
});

test('legacy modernization uses current-state architecture instead of a fixed key-question stage', async () => {
  const definition = await loadWorkflowJourney('legacy-modernization');

  assert.equal(definition.nodes.some((node) => node.id === 'investigate' || node.title === '查关键问题'), false);

  const dataTruth = definition.nodes.find((node) => node.id === 'data-truth');
  assert.equal(dataTruth?.routes.some((route) => route.target === 'current-state'), true);

  const currentState = definition.nodes.find((node) => node.id === 'current-state');
  assert.match(currentState?.title ?? '', /当前架构/);
  assert.match(currentState?.objective ?? '', /Data Source/);
  assert.match(currentState?.objective ?? '', /Data Flow/);
  assert.match(currentState?.objective ?? '', /Data Model/);
});

test('loads the architecture assessment markdown workflow', async () => {
  const definition = await loadWorkflowJourney('data-architecture-assessment');
  assert.equal(definition.id, 'data-architecture-assessment');
  assert.equal(definition.start, 'intake');
  assert.equal(definition.nodes.find((node) => node.id === 'intake')?.completeWhen, 'scope-ready');
});


test('scope-ready gate requires validated intake', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'completeWhen: scope-ready',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);

  const notReady = buildJourneyState(
    result.definition!,
    { ...baseFacts, scopeReady: false },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(notReady.execution.currentNodeId, 'intake');

  const ready = buildJourneyState(
    result.definition!,
    { ...baseFacts, scopeReady: true },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(ready.execution.currentNodeId, 'done');
});

test('current-state gate requires an actual discovered dataset', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> current',
    '',
    '## @task current',
    'completeWhen: current-state',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);

  const empty = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 0,
        semanticAssets: 0,
        parseFailures: 0,
      },
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(empty.execution.currentNodeId, 'current');

  const discovered = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 1,
        semanticAssets: 0,
        parseFailures: 0,
      },
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(discovered.execution.currentNodeId, 'done');
});

test('data-truth does not use an arbitrary lineage percentage', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> truth',
    '',
    '## @task truth',
    'completeWhen: data-truth',
    '- success -> done',
    '- retry -> truth',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);

  const incompleteLineage = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 10,
        semanticAssets: 0,
        parseFailures: 0,
      },
      highGapKinds: [],
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(incompleteLineage.execution.currentNodeId, 'done');

  const completeEnoughWithoutThreshold = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 10,
        semanticAssets: 0,
        parseFailures: 0,
      },
      highGapKinds: [],
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(completeEnoughWithoutThreshold.execution.currentNodeId, 'done');
});

test('cutover is an explicit human review after validation', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> validation',
    '',
    '## @task validation',
    'completeWhen: validation',
    '- success -> cutover',
    '',
    '## @review cutover',
    'actor: human',
    '- approved -> done',
    '- rollback -> investigate',
    '',
    '## @task investigate',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);
  const execution = initialJourneyExecution(result.definition!);
  const ready = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      blockingValidationReady: 1,
      blockingValidationTotal: 1,
    },
    execution,
  );

  assert.equal(ready.execution.currentNodeId, 'cutover');
  assert.equal(ready.execution.status, 'waiting');

  const approved = applyJourneyTransition(
    result.definition!,
    ready.execution,
    'cutover',
    'approved',
  );
  assert.equal(approved.currentNodeId, 'done');
  assert.equal(approved.status, 'completed');
});

test('assessment findings gate does not pass from current-state alone', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> findings',
    '',
    '## @task findings',
    'completeWhen: assessment-findings',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);

  const noFinding = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 1,
        semanticAssets: 1,
        parseFailures: 0,
      },
      findingCount: 0,
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(noFinding.execution.currentNodeId, 'findings');

  const withFinding = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 1,
        semanticAssets: 1,
        parseFailures: 0,
      },
      findingCount: 1,
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(withFinding.execution.currentNodeId, 'done');
});
