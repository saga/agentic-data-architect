import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowNode } from '../web/src/components/journey-map-types.js';
import {
  enforceWorkflowReadingOrder,
  removeNodeCollisions,
} from '../web/src/components/journey-map-layout.js';
import { graphFromDefinition } from '../web/src/components/journey-map-graph.js';
import type { WorkflowSnapshot, WorkflowDefinition } from '../web/src/components/journey-map-types.js';

function node(id: string, x: number, y: number): FlowNode {
  return {
    id,
    type: 'journey',
    position: { x, y },
    data: {
      title: id,
      nodeType: 'task',
      status: 'future',
      completion: 'agent',
      actor: 'agent',
      visible: true,
      sourceHandles: [{ id: id + '-out-0', label: 'success' }],
      targetHandles: [{ id: id + '-in-0', label: 'in' }],
    },
    style: { width: 236 },
  };
}

test('collision guard separates nodes that overlap or are too close', () => {
  const result = removeNodeCollisions([
    node('a', 0, 0),
    node('b', 10, 10),
    node('c', 500, 20),
  ]);

  const a = result.find((item) => item.id === 'a')!;
  const b = result.find((item) => item.id === 'b')!;

  assert.equal(a.position.x, 0);
  assert.ok(b.position.y - a.position.y >= 220);
  assert.equal(result.find((item) => item.id === 'c')?.position.x, 500);
});

test('collision guard keeps already separated nodes stable', () => {
  const result = removeNodeCollisions([
    node('a', 0, 0),
    node('b', 500, 0),
  ]);

  assert.deepEqual(
    result.map((item) => item.position),
    [
      { x: 0, y: 0 },
      { x: 500, y: 0 },
    ],
  );
});


test('reading-order guard keeps every forward edge to the right', () => {
  const a = node('a', 600, 200);
  const b = node('b', 0, 200);
  const c = node('c', 300, 200);

  const edges = [
    {
      id: 'a-b',
      source: 'a',
      target: 'b',
      sourceHandle: 'a-out-0',
      targetHandle: 'b-in-0',
      type: 'journey',
      data: { outcome: 'success' },
    },
    {
      id: 'a-c',
      source: 'a',
      target: 'c',
      sourceHandle: 'a-out-0',
      targetHandle: 'c-in-0',
      type: 'journey',
      data: { outcome: 'retry' },
    },
  ];

  const result = enforceWorkflowReadingOrder([a, b, c], edges);
  const byId = new Map(result.map((item) => [item.id, item]));

  assert.ok(byId.get('b')!.position.x > byId.get('a')!.position.x);
  assert.ok(byId.get('c')!.position.x > byId.get('a')!.position.x);
});

test('graph projection removes self-loop edges and their handles', () => {
  const definition: WorkflowDefinition = {
    id: 'demo',
    start: 'a',
    nodes: [
      {
        id: 'a',
        type: 'task',
        title: '步骤 A',
        visible: true,
        completion: 'agent',
        actor: 'agent',
        routes: [{ outcome: 'retry', target: 'a' }],
      },
      {
        id: 'done',
        type: 'end',
        title: '完成',
        visible: true,
        completion: 'agent',
        actor: 'system',
        routes: [],
      },
    ],
  };

  const snapshot = {
    workflowId: 'demo',
    source: 'base',
    baseWorkflowId: 'demo',
    version: 1,
    definition,
    layout: { version: 1, engine: 'elk-v2', nodes: {} },
    execution: {
      workflowId: 'demo',
      workflowVersion: 1,
      runId: 'demo-v1',
      currentNodeId: 'a',
      completedNodeIds: [],
      status: 'active',
    },
    state: {
      workflowId: 'demo',
      currentNodeId: 'a',
      completedNodeIds: [],
      unlockedNodeIds: ['a'],
      stages: [],
      execution: {
        workflowId: 'demo',
        workflowVersion: 1,
        runId: 'demo-v1',
        currentNodeId: 'a',
        completedNodeIds: [],
        status: 'active',
      },
    },
    analysis: [],
    events: [],
  } satisfies WorkflowSnapshot;

  const graph = graphFromDefinition(
    definition,
    snapshot.layout,
    snapshot,
  );

  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes.find((item) => item.id === 'a')!.data.sourceHandles.length, 0);
  assert.equal(graph.nodes.find((item) => item.id === 'a')!.data.targetHandles.length, 0);
});
