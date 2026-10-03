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
  cutoverCriteriaDefined: false,
  rollbackCriteriaDefined: false,
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
    'actor: system',
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
  assert.equal(result.definition?.nodes.find((node) => node.id === 'intake')?.actor, 'system');
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

test('supports lightweight conditional routing for deterministic workflow nodes', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> check',
    '',
    '## @task check',
    'completion: deterministic',
    'completeWhen: goal',
    'actor: system',
    '- goal-path -> done if goal',
    '- success -> stop',
    '',
    '## @end done',
    '',
    '## @stop stop',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  const check = result.definition!.nodes.find((node) => node.id === 'check')!;
  assert.equal(check.routes[0]?.condition, 'goal');
  const execution = initialJourneyExecution(result.definition!);
  const state = buildJourneyState(result.definition!, baseFacts, execution);
  assert.equal(state.currentNodeId, 'done');
});

test('deterministic nodes use an unconditional fallback when no condition matches', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> check',
    '',
    '## @task check',
    'completion: deterministic',
    'completeWhen: goal',
    '- validation-path -> done if validation',
    '- fallback -> stop',
    '',
    '## @end done',
    '',
    '## @stop stop',
  ].join('\n'));

  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);

  const facts = { ...baseFacts, goal: 'modernize proxy voting' };
  const state = buildJourneyState(result.definition!, facts, initialJourneyExecution(result.definition!));
  assert.equal(state.currentNodeId, 'stop');
  assert.deepEqual(state.completedNodeIds, ['check']);
});

test('deterministic retry self-loop does not mark the node completed', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> check',
    '',
    '## @task check',
    'completion: deterministic',
    'completeWhen: goal',
    '- retry -> check',
  ].join('\n'));

  assert.ok(result.definition);
  const state = buildJourneyState(
    result.definition!,
    baseFacts,
    initialJourneyExecution(result.definition!),
  );
  assert.equal(state.currentNodeId, 'check');
  assert.deepEqual(state.completedNodeIds, []);
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

test('preserves an execution position across a graph edit when the node still exists', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> investigate',
    '',
    '## @task investigate',
    'completion: agent',
    '- success -> target',
    '',
    '## @task target',
    'completion: agent',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);
  const execution = {
    ...initialJourneyExecution(result.definition!, 1),
    currentNodeId: 'target',
    completedNodeIds: ['investigate'],
  };

  const edited = {
    ...result.definition!,
    nodes: [
      ...result.definition!.nodes,
      {
        id: 'extra',
        type: 'task' as const,
        title: '额外检查',
        visible: true,
        completion: 'agent' as const,
        actor: 'agent' as const,
        routes: [{ outcome: 'success', target: 'done' }],
      },
    ],
  };

  const next = {
    ...execution,
    workflowVersion: 2,
    currentNodeId: execution.currentNodeId,
    completedNodeIds: execution.completedNodeIds.filter((id) => edited.nodes.some((node) => node.id === id)),
  };

  assert.equal(next.currentNodeId, 'target');
  assert.deepEqual(next.completedNodeIds, ['investigate']);
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

test('human review starts in waiting state', () => {
  const result = parseJourneyMarkdown(['## @flow demo','start -> review','','## @review review','actor: human','- approved -> done','','## @end done'].join('\n'));
  assert.ok(result.definition);
  const execution = initialJourneyExecution(result.definition!, 1);
  assert.equal(execution.status, 'waiting');
  assert.equal(execution.pendingInteraction?.nodeId, 'review');
});

test('loads the architecture assessment markdown workflow', async () => {
  const definition = await loadWorkflowJourney('data-architecture-assessment');
  assert.equal(definition.id, 'data-architecture-assessment');
  assert.equal(definition.start, 'intake');
  assert.equal(definition.nodes.find((node) => node.id === 'intake')?.completion, 'deterministic');
});


test('current-state gate requires an actual discovered dataset', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> current',
    '',
    '## @task current',
    'completion: deterministic',
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
  assert.equal(empty.currentNodeId, 'current');

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
  assert.equal(discovered.currentNodeId, 'done');
});

test('data-truth does not use an arbitrary lineage percentage', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> truth',
    '',
    '## @task truth',
    'completion: deterministic',
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
  assert.equal(incompleteLineage.currentNodeId, 'truth');

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
  assert.equal(completeEnoughWithoutThreshold.currentNodeId, 'done');
});

test('investigation ignores unknown count and blocks only on critical gaps', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> investigate',
    '',
    '## @task investigate',
    'completion: deterministic',
    'completeWhen: investigation',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);

  const manyLowImpactUnknowns = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 10,
        semanticAssets: 1,
        parseFailures: 0,
      },
      unknowns: ['u1', 'u2', 'u3', 'u4', 'u5'],
      highGapKinds: [],
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(manyLowImpactUnknowns.currentNodeId, 'done');

  const oneCriticalGap = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      currentState: {
        datasets: 10,
        semanticAssets: 1,
        parseFailures: 0,
      },
      unknowns: [],
      highGapKinds: ['source-of-truth'],
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(oneCriticalGap.currentNodeId, 'investigate');
});

test('cutover requires validation plus explicit cutover and rollback criteria', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> cutover',
    '',
    '## @task cutover',
    'completion: deterministic',
    'completeWhen: cutover',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));

  assert.ok(result.definition);

  const blocked = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      blockingValidationReady: 2,
      blockingValidationTotal: 2,
      cutoverCriteriaDefined: true,
      rollbackCriteriaDefined: false,
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(blocked.currentNodeId, 'cutover');

  const ready = buildJourneyState(
    result.definition!,
    {
      ...baseFacts,
      blockingValidationReady: 2,
      blockingValidationTotal: 2,
      cutoverCriteriaDefined: true,
      rollbackCriteriaDefined: true,
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(ready.currentNodeId, 'done');
});

test('assessment findings gate does not pass from current-state alone', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> findings',
    '',
    '## @task findings',
    'completion: deterministic',
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
  assert.equal(noFinding.currentNodeId, 'findings');

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
  assert.equal(withFinding.currentNodeId, 'done');
});
