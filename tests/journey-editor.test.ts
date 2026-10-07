import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultJourneyLayout,
  sameJourneyExecution,
  serializeJourneyMarkdown,
} from '../src/workflow/journey-editor.js';
import {
  applyJourneyWorkflowChanges,
  validateJourneyChangeScope,
} from '../src/workflow/journey-edit.js';
import { parseJourneyMarkdown } from '../src/workflow/journey.js';

test('journey editor serialization round-trips semantic graph', () => {
  const definition = {
    id: 'demo',
    start: 'intake',
    nodes: [
      {
        id: 'intake',
        type: 'task' as const,
        title: '明确目标',
        objective: '确认范围',
        actor: 'agent' as const,
        completeWhen: 'goal',
        routes: [
          { outcome: 'success', target: 'review' },
        ],
      },
      {
        id: 'review',
        type: 'review' as const,
        title: '人工确认',
        actor: 'human' as const,
        routes: [{ outcome: 'success', target: 'done' }],
      },
      {
        id: 'done',
        type: 'end' as const,
        title: '完成',
        actor: 'agent' as const,
        routes: [],
      },
    ],
  };

  const markdown = serializeJourneyMarkdown(definition);
  const parsed = parseJourneyMarkdown(markdown);

  assert.equal(parsed.issues.length, 0);
  assert.ok(parsed.definition);
  assert.equal(parsed.definition?.nodes[0]?.completeWhen, 'goal');
  assert.equal(parsed.definition?.nodes[0]?.actor, 'agent');
  assert.deepEqual(
    parsed.definition?.nodes[0]?.routes.map(({ outcome, target }) => ({ outcome, target })),
    [
      { outcome: 'success', target: 'review' },
    ],
  );
});




test('selection-scoped Workflow AI cannot connect a new node to an unrelated node', () => {
  const definition = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',

    '- success -> review',
    '',
    '## @task review',

    '- success -> done',
    '',
    '## @task unrelated',

    '- success -> done',
    '',
    '## @end done',
  ].join('\n')).definition!;

  const changes = [
    {
      type: 'add-node' as const,
      node: {
        id: 'new-step',
        type: 'task' as const,
        title: '新步骤',
        actor: 'agent' as const,
        routes: [{ outcome: 'success', target: 'unrelated' }],
      },
    },
  ];

  const issues = validateJourneyChangeScope(definition, changes, 'review');
  assert.ok(issues.some((issue) => issue.includes('new-step') && issue.includes('unrelated')));
});

test('workflow transition snapshot comparator rejects ABA state changes', () => {
  const base = {
    workflowId: 'demo',
    workflowVersion: 1,
    runId: 'demo-v1',
    currentNodeId: 'review',
    completedNodeIds: ['intake'],
    status: 'active' as const,
  };

  const same = { ...base };
  const changedAndBack = {
    ...base,
    // currentNodeId 仍然是 review，但中间经过其它节点后 completed history 已经不同。
    completedNodeIds: ['intake', 'discovery'],
  };
  const waitingState = {
    ...base,
    status: 'waiting' as const,
    pendingInteraction: {
      id: 'pending-demo',
      nodeId: 'review',
      reason: '等待人工确认。',
      requestedAt: '2026-10-08T00:00:00.000Z',
    },
  };

  assert.equal(sameJourneyExecution(base, same), true);
  assert.equal(sameJourneyExecution(base, changedAndBack), false);
  assert.equal(sameJourneyExecution(base, waitingState), false);
});
