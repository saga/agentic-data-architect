import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FlowEdge,
  FlowNode,
  WorkflowDefinition,
  WorkflowSnapshot,
} from '../web/src/components/journey-map-types.js';
import {
  calculateWorkflowRanks,
  layoutWorkflow,
  removeNodeCollisions,
} from '../web/src/components/journey-map-layout.js';
import { graphFromDefinition } from '../web/src/components/journey-map-graph.js';

function node(id: string, x = 0, y = 0): FlowNode {
  return {
    id,
    type: 'journey',
    position: { x, y },
    width: 236,
    height: 210,
    data: {
      title: id,
      nodeType: 'task',
      status: 'future',
      actor: 'agent',
      sourceHandles: [{ id: id + '-out-0', label: 'success' }],
      targetHandles: [{ id: id + '-in-0', label: 'in' }],
    },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  outcome = 'success',
): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: source + '-out-0',
    targetHandle: target + '-in-0',
    data: { outcome },
  };
}

test('workflow layout keeps the main path vertical and branch nodes off the main line', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const edges = [
    edge('a-b', 'a', 'b', 'success'),
    edge('a-c', 'a', 'c', 'failed'),
    edge('b-d', 'b', 'd', 'success'),
    edge('c-d', 'c', 'd', 'success'),
  ];

  const result = layoutWorkflow(nodes, edges);
  const byId = new Map(result.map((item) => [item.id, item]));

  assert.equal(byId.get('a')!.position.x, byId.get('b')!.position.x);
  assert.equal(byId.get('b')!.position.x, byId.get('d')!.position.x);
  assert.notEqual(byId.get('c')!.position.x, byId.get('a')!.position.x);
  assert.ok(byId.get('b')!.position.y > byId.get('a')!.position.y);
  assert.ok(byId.get('c')!.position.y > byId.get('a')!.position.y);
});

test('loop edges do not change forward ranks', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const edges = [
    edge('a-b', 'a', 'b', 'success'),
    edge('b-c', 'b', 'c', 'success'),
    edge('c-a', 'c', 'a', 'retry'),
  ];

  const ranks = calculateWorkflowRanks(nodes, edges);

  assert.equal(ranks.get('a'), 0);
  assert.equal(ranks.get('b'), 1);
  assert.equal(ranks.get('c'), 2);
});

test('collision guard moves only overlapping nodes', () => {
  const result = removeNodeCollisions([
    node('a', 0, 0),
    node('b', 10, 10),
    node('c', 500, 20),
  ]);

  const a = result.find((item) => item.id === 'a')!;
  const b = result.find((item) => item.id === 'b')!;

  assert.equal(a.position.x, 0);
  assert.ok(b.position.y >= a.position.y + 210);
  assert.equal(result.find((item) => item.id === 'c')?.position.x, 500);
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
        actor: 'agent',
        routes: [{ outcome: 'retry', target: 'a' }],
      },
      {
        id: 'done',
        type: 'end',
        title: '完成',
        actor: 'agent',
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
    layout: { version: 1, engine: 'workflow-v1', nodes: {} },
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
        completedNodeIds: [],
        currentNodeId: 'a',
        status: 'active',
      },
    },
     events: [],
  } satisfies WorkflowSnapshot;

  const graph = graphFromDefinition(definition, snapshot.layout, snapshot);

  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes.find((item) => item.id === 'a')!.data.sourceHandles.length, 0);
  assert.equal(graph.nodes.find((item) => item.id === 'a')!.data.targetHandles.length, 1);
  assert.equal(graph.nodes.find((item) => item.id === 'a')!.data.targetHandles[0]?.label, '入口');
});
