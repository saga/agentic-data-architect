import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultJourneyLayout,
  serializeJourneyMarkdown,
} from '../src/workflow/journey-editor.js';
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
        completeWhen: 'goal',
        routes: [
          { outcome: 'success', target: 'review' },
          { outcome: 'needs-input', target: 'intake' },
        ],
      },
      {
        id: 'review',
        type: 'review' as const,
        title: '人工确认',
        visible: true,
        completion: 'agent' as const,
        routes: [{ outcome: 'success', target: 'done' }],
      },
      {
        id: 'done',
        type: 'end' as const,
        title: '完成',
        visible: false,
        completion: 'agent' as const,
        routes: [],
      },
    ],
  };

  const markdown = serializeJourneyMarkdown(definition);
  const parsed = parseJourneyMarkdown(markdown);

  assert.equal(parsed.issues.length, 0);
  assert.ok(parsed.definition);
  assert.equal(parsed.definition?.nodes[0]?.completion, 'deterministic');
  assert.deepEqual(parsed.definition?.nodes[0]?.routes, [
    { outcome: 'success', target: 'review', line: 10 },
    { outcome: 'needs-input', target: 'intake', line: 11 },
  ]);
});

test('default layout gives every node a stable position', () => {
  const definition = {
    id: 'demo',
    start: 'a',
    nodes: [
      { id: 'a', type: 'task' as const, title: 'A', visible: true, completion: 'agent' as const, routes: [{ outcome: 'success', target: 'b' }] },
      { id: 'b', type: 'task' as const, title: 'B', visible: true, completion: 'agent' as const, routes: [{ outcome: 'success', target: 'done' }] },
      { id: 'done', type: 'end' as const, title: 'Done', visible: false, completion: 'agent' as const, routes: [] },
    ],
  };

  const layout = defaultJourneyLayout(definition);
  assert.ok(layout.nodes.a);
  assert.ok(layout.nodes.b);
  assert.ok(layout.nodes.done);
});
