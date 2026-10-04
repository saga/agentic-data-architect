import type { FlowEdge, FlowNode, JourneyEdgeKind } from './journey-map-types.js';

const SUCCESS_PATTERNS = [
  'success',
  'succeed',
  'succeeded',
  'pass',
  'passed',
  'complete',
  'completed',
  'done',
  'continue',
  'next',
  'ok',
  'yes',
  '成功',
  '完成',
  '通过',
  '继续',
];

const FAIL_PATTERNS = [
  'fail',
  'failed',
  'failure',
  'error',
  'reject',
  'rejected',
  'deny',
  'denied',
  'stop',
  'stopped',
  '失败',
  '错误',
  '拒绝',
  '不通过',
  '终止',
];

const RETRY_PATTERNS = [
  'retry',
  'rework',
  'redo',
  'revisit',
  'rollback',
  'again',
  'retrying',
  '重试',
  '重新',
  '回退',
];

function matchesPattern(outcome: string, patterns: string[]): boolean {
  return patterns.some((pattern) => outcome.includes(pattern));
}

/**
 * 只决定工作地图怎么画，不改变 Workflow DSL 的 outcome。
 * 顺序很重要：retry 优先于 fail，避免 “rollback-after-fail” 一类结果被误判。
 */
export function classifyJourneyEdge(outcome: string | undefined): JourneyEdgeKind {
  const normalized = String(outcome ?? '').trim().toLowerCase();

  if (matchesPattern(normalized, RETRY_PATTERNS)) return 'retry';
  if (matchesPattern(normalized, FAIL_PATTERNS)) return 'fail';
  if (matchesPattern(normalized, SUCCESS_PATTERNS)) return 'success';
  return 'other';
}

/**
 * 为重试关系找一组真正相关的步骤。
 *
 * 例如 A -> B -> C，C --retry--> A：
 * 重试组就是 A/B/C，而不是只把 A 和 C 框起来。
 *
 * 这里只做视觉分组，不改变 Workflow Definition，也不生成第二套执行语义。
 */
export function buildRetryGroups(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Array<{ id: string; nodeIds: string[] }> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const semanticEdges = edges.filter(
    (edge) =>
      nodeIds.has(edge.source)
      && nodeIds.has(edge.target)
      && edge.source !== edge.target,
  );

  const nonRetryOutgoing = new Map<string, FlowEdge[]>();
  for (const edge of semanticEdges) {
    if (classifyJourneyEdge(edge.data?.outcome) === 'retry') continue;

    nonRetryOutgoing.set(edge.source, [
      ...(nonRetryOutgoing.get(edge.source) ?? []),
      edge,
    ]);
  }

  const parentPaths = (
    startId: string,
    targetId: string,
  ): string[] => {
    const queue = [startId];
    const previous = new Map<string, string | null>([[startId, null]]);

    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      if (current === targetId) break;

      for (const edge of nonRetryOutgoing.get(current) ?? []) {
        if (previous.has(edge.target)) continue;
        previous.set(edge.target, current);
        queue.push(edge.target);
      }
    }

    if (!previous.has(targetId)) {
      return [startId, targetId];
    }

    const path: string[] = [];
    let current: string | null = targetId;

    while (current) {
      path.unshift(current);
      current = previous.get(current) ?? null;
    }

    return path;
  };

  const groups: Array<Set<string>> = [];

  for (const edge of semanticEdges) {
    if (classifyJourneyEdge(edge.data?.outcome) !== 'retry') continue;

    const members = new Set(parentPaths(edge.target, edge.source));
    const merged = groups.find((group) => [...members].some((id) => group.has(id)));

    if (merged) {
      for (const id of members) merged.add(id);
    } else {
      groups.push(members);
    }
  }

  return groups
    .filter((group) => group.size >= 2)
    .map((group, index) => ({
      id: 'retry-group-' + String(index + 1),
      nodeIds: [...group],
    }));
}
