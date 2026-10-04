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

test('workflow layout uses a 2D S-shaped main path with side branches', () => {
  const nodes = [
    node('a'),
    node('b'),
    node('c'),
    node('d'),
    node('e'),
    node('f'),
  ];
  const edges = [
    edge('a-b', 'a', 'b', 'success'),
    edge('a-c', 'a', 'c', 'failed'),
    edge('b-d', 'b', 'd', 'success'),
    edge('c-d', 'c', 'd', 'success'),
    edge('d-e', 'd', 'e', 'success'),
    edge('e-f', 'e', 'f', 'success'),
  ];

  const result = layoutWorkflow(nodes, edges);
  const byId = new Map(result.map((item) => [item.id, item]));

  // 主线不再全部落在同一个 x；仍然保持从上到下的阅读方向。
  const mainXs = ['a', 'b', 'd', 'e', 'f'].map((id) => byId.get(id)!.position.x);
  assert.ok(new Set(mainXs).size >= 3);
  assert.ok(byId.get('b')!.position.y > byId.get('a')!.position.y);
  assert.ok(byId.get('d')!.position.y > byId.get('b')!.position.y);
  assert.ok(byId.get('f')!.position.y > byId.get('e')!.position.y);

  // 分支节点不与主线重合，且与起点不在同一列。
  assert.notEqual(byId.get('c')!.position.x, byId.get('a')!.position.x);
  assert.ok(Math.abs(byId.get('c')!.position.x - byId.get('a')!.position.x) >= 200);

  // 不是“横线/竖线”旋转，而是明显占用二维空间。
  const xs = result.map((item) => item.position.x);
  const ys = result.map((item) => item.position.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  assert.ok(width > 500);
  assert.ok(height > width);
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
    layout: { version: 1, engine: 'workflow-v2', nodes: {} },
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
