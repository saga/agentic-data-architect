import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJourneyTransition,
  buildJourneyState,
  isAgentWorkflowCompletionAllowed,
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
  targetStatus: 'draft',
  targetComponentCount: 0,
  mappingStatuses: [],
  validationStatuses: [],
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

test('unknown completeWhen is rejected by Workflow validation', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> step',
    '',
    '## @task step',
    'completeWhen: made-up-condition',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n'));
  assert.ok(result.definition);
  assert.ok(validateJourneyDefinition(result.definition!).some((issue) => issue.includes('未知的 completeWhen')));
});

test('Agent cannot advance a conditionless task without Stage Gate approval', () => {
  const node = { actor: 'agent' as const, completeWhen: undefined };
  assert.equal(isAgentWorkflowCompletionAllowed(node, baseFacts, false), false);
  assert.equal(isAgentWorkflowCompletionAllowed(node, baseFacts, true), true);
});

test('Agent completion still uses deterministic facts when completeWhen exists', () => {
  const node = { actor: 'agent' as const, completeWhen: 'scope-ready' };
  assert.equal(isAgentWorkflowCompletionAllowed(node, { ...baseFacts, scopeReady: false }, true), false);
  assert.equal(isAgentWorkflowCompletionAllowed(node, { ...baseFacts, scopeReady: true }, false), true);
});

test('deterministic completion cannot jump to @end before Mission completion', () => {
  const result = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'completeWhen: goal',
    '- success -> done',
    '',
    '## @end done',
  ].join('\\n'));

  assert.ok(result.definition);
  const incomplete = buildJourneyState(
    result.definition!,
    { ...baseFacts, missionComplete: false },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(incomplete.execution.currentNodeId, 'intake');
  assert.deepEqual(incomplete.execution.completedNodeIds, []);

  const complete = buildJourneyState(
    result.definition!,
    { ...baseFacts, missionComplete: true },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(complete.execution.currentNodeId, 'done');
  assert.deepEqual(complete.execution.completedNodeIds, ['intake']);
  assert.equal(complete.execution.status, 'completed');
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
      targetStatus: 'in_review',
      targetComponentCount: 1,
      mappingStatuses: ['reviewed'],
      validationStatuses: [{ status: 'passed', blocking: true }],
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
      assessmentPlanExists: true,
    },
    initialJourneyExecution(result.definition!),
  );
  assert.equal(withFinding.execution.currentNodeId, 'done');
});




