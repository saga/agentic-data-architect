import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowRunEvent } from '../web/src/components/journey-map-types.js';
import { replayExecutionAt, replayEventLabel } from '../web/src/components/journey-map-replay.js';

const definition = { id: 'workflow-1', start: 'discover' };
const events: WorkflowRunEvent[] = [
  {
    id: 'e1',
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    type: 'workflow-started',
    timestamp: '2026-10-07T04:00:00.000Z',
  },
  {
    id: 'e2',
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    type: 'node-started',
    timestamp: '2026-10-07T04:00:01.000Z',
    nodeId: 'discover',
  },
  {
    id: 'e3',
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    type: 'node-completed',
    timestamp: '2026-10-07T04:00:02.000Z',
    nodeId: 'discover',
    data: { nextNodeId: 'structural-analysis' },
  },
  {
    id: 'e4',
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    type: 'node-started',
    timestamp: '2026-10-07T04:00:03.000Z',
    nodeId: 'structural-analysis',
  },
  {
    id: 'e5',
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    type: 'node-waiting',
    timestamp: '2026-10-07T04:00:04.000Z',
    nodeId: 'structural-analysis',
    data: {
      id: 'input-1',
      nodeId: 'structural-analysis',
      reason: '需要人工确认',
      requestedAt: '2026-10-07T04:00:04.000Z',
      deterministic: true,
    },
  },
  {
    id: 'e6',
    runId: 'run-1',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    type: 'workflow-completed',
    timestamp: '2026-10-07T04:00:05.000Z',
  },
];

test('replayExecutionAt reconstructs workflow state from recorded events', () => {
  assert.deepEqual(replayExecutionAt(definition, events, 0), {
    workflowId: 'workflow-1',
    workflowVersion: 0,
    runId: 'run-1',
    currentNodeId: 'discover',
    completedNodeIds: [],
    status: 'active',
  });

  const afterCompletion = replayExecutionAt(definition, events as never[], 3);
  assert.equal(afterCompletion.currentNodeId, 'structural-analysis');
  assert.deepEqual(afterCompletion.completedNodeIds, ['discover']);
  assert.equal(afterCompletion.status, 'active');

  const waiting = replayExecutionAt(definition, events as never[], 5);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.pendingInteraction?.nodeId, 'structural-analysis');

  const completed = replayExecutionAt(definition, events as never[], events.length);
  assert.equal(completed.status, 'completed');
});

test('replayEventLabel uses human-readable runtime events', () => {
  assert.equal(replayEventLabel(events[0]), '开始执行');
  assert.equal(replayEventLabel(events[2]), '完成步骤');
  assert.equal(replayEventLabel(events[4]), '等待人工');
  assert.equal(replayEventLabel(events[5]), '执行完成');
});
