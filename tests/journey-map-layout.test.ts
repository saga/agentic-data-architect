import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowNode } from '../web/src/components/journey-map-types.js';
import { removeNodeCollisions } from '../web/src/components/journey-map-layout.js';

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
      visible: true,
      editing: true,
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
