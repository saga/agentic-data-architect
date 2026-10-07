import type { WorkflowExecution, WorkflowRunEvent } from './journey-map-types.js';

export function replayExecutionAt(
  definition: { id: string; start: string },
  events: WorkflowRunEvent[],
  index: number,
): WorkflowExecution {
  const execution: WorkflowExecution = {
    workflowId: definition.id,
    workflowVersion: 0,
    runId: events[0]?.runId ?? 'replay',
    currentNodeId: definition.start,
    completedNodeIds: [],
    status: 'active',
  };

  for (const event of events.slice(0, index)) {
    if (event.workflowVersion > 0) execution.workflowVersion = event.workflowVersion;
    if (event.nodeId) execution.currentNodeId = event.nodeId;
    switch (event.type) {
      case 'node-started':
        execution.status = 'active';
        break;
      case 'node-completed': {
        if (event.nodeId && !execution.completedNodeIds.includes(event.nodeId)) {
          execution.completedNodeIds.push(event.nodeId);
        }
        const nextNodeId = event.data && 'nextNodeId' in event.data ? event.data.nextNodeId : undefined;
        if (nextNodeId) execution.currentNodeId = nextNodeId;
        execution.status = 'active';
        break;
      }
      case 'node-waiting':
        execution.status = 'waiting';
        if (event.data && 'nodeId' in event.data) execution.currentNodeId = event.data.nodeId;
        if (event.data && 'id' in event.data) {
          execution.pendingInteraction = {
            id: event.data.id,
            nodeId: event.data.nodeId,
            reason: event.data.reason,
            requestedAt: event.data.requestedAt,
          };
        }
        break;
      case 'node-failed':
        execution.status = 'active';
        break;
      case 'workflow-completed':
        execution.status = 'completed';
        break;
      default:
        break;
    }
    if (event.type !== 'node-waiting' && execution.status !== 'waiting') delete execution.pendingInteraction;
  }
  return execution;
}

export function replayEventLabel(event: WorkflowRunEvent): string {
  switch (event.type) {
    case 'workflow-started': return '开始执行';
    case 'node-started': return '进入步骤';
    case 'node-completed': return '完成步骤';
    case 'node-waiting': return '等待人工';
    case 'node-failed': return '步骤失败';
    case 'workflow-completed': return '执行完成';
    case 'transition-rejected': return '转换被拒绝';
    default: return event.type;
  }
}
