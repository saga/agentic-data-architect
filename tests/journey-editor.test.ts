import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultJourneyLayout,
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
        visible: true,
        completion: 'deterministic' as const,
        actor: 'system' as const,
        completeWhen: 'goal',
        routes: [
          { outcome: 'success', target: 'review', condition: 'goal' },
          { outcome: 'needs-input', target: 'intake' },
        ],
      },
      {
        id: 'review',
        type: 'review' as const,
        title: '人工确认',
        visible: true,
        completion: 'agent' as const,
        actor: 'human' as const,
        routes: [{ outcome: 'success', target: 'done' }],
      },
      {
        id: 'done',
        type: 'end' as const,
        title: '完成',
        visible: false,
        completion: 'agent' as const,
        actor: 'system' as const,
        routes: [],
      },
    ],
  };

  const markdown = serializeJourneyMarkdown(definition);
  const parsed = parseJourneyMarkdown(markdown);

  assert.equal(parsed.issues.length, 0);
  assert.ok(parsed.definition);
  assert.equal(parsed.definition?.nodes[0]?.completion, 'deterministic');
  assert.equal(parsed.definition?.nodes[0]?.actor, 'system');
  assert.deepEqual(
    parsed.definition?.nodes[0]?.routes.map(({ outcome, target, condition }) => ({
      outcome,
      target,
      ...(condition !== undefined ? { condition } : {}),
    })),
    [
      { outcome: 'success', target: 'review', condition: 'goal' },
      { outcome: 'needs-input', target: 'intake' },
    ],
  );
});

test('default layout gives every node a stable position', () => {
  const definition = {
    id: 'demo',
    start: 'a',
    nodes: [
      { id: 'a', type: 'task' as const, title: 'A', visible: true, completion: 'agent' as const, actor: 'agent' as const, routes: [{ outcome: 'success', target: 'b' }] },
      { id: 'b', type: 'task' as const, title: 'B', visible: true, completion: 'agent' as const, actor: 'agent' as const, routes: [{ outcome: 'success', target: 'done' }] },
      { id: 'done', type: 'end' as const, title: 'Done', visible: false, completion: 'agent' as const, actor: 'system' as const, routes: [] },
    ],
  };

  const layout = defaultJourneyLayout(definition);
  assert.ok(layout.nodes.a);
  assert.ok(layout.nodes.b);
  assert.ok(layout.nodes.done);
});


test('selection-scoped Workflow AI cannot connect a new node to an unrelated node', () => {
  const definition = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'completion: agent',
    '- success -> review',
    '',
    '## @task review',
    'completion: agent',
    '- success -> done',
    '',
    '## @task unrelated',
    'completion: agent',
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
        visible: true,
        completion: 'agent' as const,
        actor: 'agent' as const,
        routes: [{ outcome: 'success', target: 'unrelated' }],
      },
    },
  ];

  const issues = validateJourneyChangeScope(definition, changes, 'review');
  assert.ok(issues.some((issue) => issue.includes('new-step') && issue.includes('unrelated')));
});

test('Workflow patch preserves dependency declarations', () => {
  const definition = parseJourneyMarkdown([
    '## @flow demo',
    'start -> intake',
    '',
    '## @task intake',
    'completion: agent',
    'produces: evidence',
    '- success -> target',
    '',
    '## @task target',
    'completion: agent',
    'requires: evidence',
    '- success -> done',
    '',
    '## @end done',
  ].join('\n')).definition!;

  const next = applyJourneyWorkflowChanges(definition, [{
    type: 'update-node',
    nodeId: 'target',
    patch: {
      requires: ['evidence', 'mapping'],
    },
  }]);

  assert.deepEqual(next.nodes.find((node) => node.id === 'target')?.requires, ['evidence', 'mapping']);
});
