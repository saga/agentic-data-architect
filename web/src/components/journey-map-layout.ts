import type {
  FlowEdge,
  FlowNode,
  WorkflowLayout,
} from './journey-map-types.js';
import { JOURNEY_NODE_SIZE } from './journey-map-types.js';
import { classifyJourneyEdge } from './journey-map-visuals.js';

/**
 * Workflow-specific 自动排版。
 *
 * X6 负责画布、节点、Port、Edge 和路由；这里不再引入 ELK。
 * 工作地图不是任意 DAG，而是“主流程 + 少量分支 + 少量回退”的工作流。
 *
 * 布局规则：
 * 1. 沿 Workflow start 的前向边计算 rank，rank 决定上下层级。
 * 2. success / done / pass 等主出口组成中间主线。
 * 3. 其它分支进入主线的左右 lane。
 * 4. 循环/回退边不参与 rank，避免把整张图拉成长斜线。
 * 5. 最后只做一次简单矩形碰撞保护。
 */

const MAIN_X = 420;
const MAIN_Y = 56;
const ROW_GAP = 168;
const LANE_GAP = 300;
const CANVAS_PADDING = 56;
const COLLISION_GAP = 36;

export const WORKFLOW_LAYOUT_ENGINE = 'workflow-v2' as const;

function nodeDimensions(node: FlowNode): { width: number; height: number } {
  const terminal =
    node.data.nodeType === 'end';
  const defaults = terminal
    ? JOURNEY_NODE_SIZE.terminal
    : JOURNEY_NODE_SIZE.regular;

  return {
    width: node.width ?? defaults.width,
    height: node.height ?? defaults.height,
  };
}

function isPrimaryRoute(edge: FlowEdge): boolean {
  return classifyJourneyEdge(edge.data?.outcome) === 'success';
}

/** 只用图结构识别循环边，不依赖 retry / rollback 等 outcome 字符串。 */
function findBackEdges(nodes: FlowNode[], edges: FlowEdge[]): Set<string> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, FlowEdge[]>();

  for (const edge of edges) {
    if (
      edge.source === edge.target
      || classifyJourneyEdge(edge.data?.outcome) === 'retry'
      || !nodeIds.has(edge.source)
      || !nodeIds.has(edge.target)
    ) continue;

    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge,
    ]);
  }

  for (const [source, sourceEdges] of adjacency) {
    sourceEdges.sort(
      (a, b) =>
        Number(isPrimaryRoute(b)) - Number(isPrimaryRoute(a))
        || a.target.localeCompare(b.target)
        || a.id.localeCompare(b.id),
    );
    adjacency.set(source, sourceEdges);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const backEdges = new Set<string>();

  const visit = (nodeId: string) => {
    visiting.add(nodeId);

    for (const edge of adjacency.get(nodeId) ?? []) {
      if (visiting.has(edge.target)) {
        backEdges.add(edge.id);
      } else if (!visited.has(edge.target)) {
        visit(edge.target);
      }
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  const incoming = new Set<string>();
  for (const sourceEdges of adjacency.values()) {
    for (const edge of sourceEdges) incoming.add(edge.target);
  }

  const roots = nodes
    .filter((node) => !incoming.has(node.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const root of roots) {
    if (!visited.has(root.id)) visit(root.id);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) visit(node.id);
  }

  return backEdges;
}

export function getForwardLayoutEdges(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const backEdges = findBackEdges(nodes, edges);

  return edges.filter(
    (edge) =>
      edge.source !== edge.target
      && nodeIds.has(edge.source)
      && nodeIds.has(edge.target)
      && classifyJourneyEdge(edge.data?.outcome) !== 'retry'
      && !backEdges.has(edge.id),
  );
}

/**
 * 计算从左到右的 Workflow rank。
 * start 采用前向图入度为 0 的节点；异常/孤立节点再依次放到末尾。
 */
export function calculateWorkflowRanks(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Map<string, number> {
  const forwardEdges = getForwardLayoutEdges(nodes, edges);
  const incoming = new Set(forwardEdges.map((edge) => edge.target));
  const startNode = nodes.find((node) => !incoming.has(node.id)) ?? nodes[0];
  const ranks = new Map<string, number>(
    nodes.map((node) => [node.id, -1]),
  );

  if (startNode) ranks.set(startNode.id, 0);

  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;

    for (const edge of forwardEdges) {
      const sourceRank = ranks.get(edge.source);
      if (!Number.isFinite(sourceRank)) continue;

      const nextRank = Number(sourceRank) + 1;
      const currentRank = ranks.get(edge.target) ?? -1;

      if (nextRank <= currentRank) continue;

      ranks.set(edge.target, nextRank);
      changed = true;
    }

    if (!changed) break;
  }

  let maxRank = 0;
  for (const rank of ranks.values()) {
    if (Number.isFinite(rank)) maxRank = Math.max(maxRank, rank);
  }

  for (const node of nodes) {
    if ((ranks.get(node.id) ?? -1) < 0) {
      maxRank += 1;
      ranks.set(node.id, maxRank);
    }
  }

  return ranks;
}

/** 找到一条视觉主线；只影响坐标，不改变 Workflow。 */
export function findMainFlowNodes(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Set<string> {
  const forwardEdges = getForwardLayoutEdges(nodes, edges);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Set(forwardEdges.map((edge) => edge.target));
  const start = nodes.find((node) => !incoming.has(node.id)) ?? nodes[0];
  const main = new Set<string>();
  let current = start?.id;

  while (current && !main.has(current)) {
    main.add(current);

    const candidates = forwardEdges
      .filter((edge) => edge.source === current && !main.has(edge.target))
      .sort(
        (a, b) =>
          Number(isPrimaryRoute(b)) - Number(isPrimaryRoute(a))
          || (nodeById.get(a.target)?.position.x ?? 0)
            - (nodeById.get(b.target)?.position.x ?? 0)
          || a.target.localeCompare(b.target),
      );

    current = candidates[0]?.target;
  }

  return main;
}

/**
 * 把主流程做成轻微 S 型；分支始终贴着自己的主线父节点向外展开。
 *
 * lane 只是视觉列编号：
 * - 主线使用 MAIN_LANE_PATTERN；
 * - 分支优先落在父节点 lane 的外侧；
 * - 同一 rank 已被占用时，再向外找空 lane。
 *
 * 不把“左边/右边”写进 Workflow，也不根据 outcome 名称决定布局。
 */
function assignLanes(
  nodes: FlowNode[],
  edges: FlowEdge[],
  ranks: Map<string, number>,
  mainFlow: Set<string>,
): Map<string, number> {
  const forwardEdges = getForwardLayoutEdges(nodes, edges);
  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();

  for (const edge of forwardEdges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }

  const lanes = new Map<string, number>();
  const usedByRank = new Map<number, Set<number>>();

  const reserve = (nodeId: string, lane: number) => {
    lanes.set(nodeId, lane);
    const rank = ranks.get(nodeId) ?? 0;
    const used = usedByRank.get(rank) ?? new Set<number>();
    used.add(lane);
    usedByRank.set(rank, used);
  };

  const mainLane = (rank: number): number =>
    MAIN_LANE_PATTERN[rank % MAIN_LANE_PATTERN.length] ?? 0;

  // 先把主线固定成稳定的 S 型轨迹。
  for (const node of nodes) {
    if (mainFlow.has(node.id)) reserve(node.id, mainLane(ranks.get(node.id) ?? 0));
  }

  /**
   * 找离父 lane 最近、但在当前层不冲突的列。
   * preferredSide=true 表示优先向父节点右侧展开，否则向左侧展开。
   */
  const freeLane = (
    used: Set<number>,
    parentLane: number,
    preferredSide: 'left' | 'right',
  ): number => {
    const direction = preferredSide === 'right' ? 1 : -1;

    for (let distance = 1; distance < 100; distance += 1) {
      const candidate = parentLane + direction * distance;
      if (!used.has(candidate)) return candidate;
    }

    for (let distance = 1; distance < 100; distance += 1) {
      const candidate = parentLane - direction * distance;
      if (!used.has(candidate)) return candidate;
    }

    return parentLane + direction * 100;
  };

  // 主线直接分出的第一层分支，固定在主线外侧，避免左右抖动。
  for (const node of nodes) {
    if (!mainFlow.has(node.id)) continue;

    const candidates = (outgoing.get(node.id) ?? [])
      .filter((edge) => !isPrimaryRoute(edge) && !mainFlow.has(edge.target))
      .sort((a, b) => a.target.localeCompare(b.target) || a.id.localeCompare(b.id));

    for (const [index, edge] of candidates.entries()) {
      const rank = ranks.get(edge.target) ?? 0;
      const used = usedByRank.get(rank) ?? new Set<number>();
      const parentLane = lanes.get(node.id) ?? 0;

      // 第一支放外侧，第二支再放更外一列；同一分叉点的结构保持稳定。
      const preferredSide = index % 2 === 0 ? 'left' : 'right';
      const lane = freeLane(used, parentLane, preferredSide);
      reserve(edge.target, lane);
    }
  }

  // 分支链继续沿用父节点附近的 lane，不让每一层重新洗牌。
  const grouped = new Map<number, FlowNode[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    grouped.set(rank, [...(grouped.get(rank) ?? []), node]);
  }

  const maxRank = Math.max(...Array.from(grouped.keys()), 0);

  for (let rank = 0; rank <= maxRank; rank += 1) {
    for (const node of grouped.get(rank) ?? []) {
      if (lanes.has(node.id)) continue;

      const parentLane = (incoming.get(node.id) ?? [])
        .map((edge) => lanes.get(edge.source))
        .find((lane): lane is number => lane !== undefined);

      const anchorLane = parentLane ?? mainLane(rank);
      const used = usedByRank.get(rank) ?? new Set<number>();
      const preferredSide: 'left' | 'right' =
        anchorLane <= 0 ? 'left' : 'right';

      reserve(
        node.id,
        freeLane(used, anchorLane, preferredSide),
      );
    }
  }

  return lanes;
}

function copyNode(node: FlowNode, x: number, y: number): FlowNode {
  return { ...node, position: { x, y } };
}

/** 最后一层矩形碰撞保护；不再做第二套阅读顺序布局。 */
export function removeNodeCollisions(nodes: FlowNode[]): FlowNode[] {
  const result = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
  }));

  for (let i = 0; i < result.length; i += 1) {
    const current = result[i];
    const currentSize = nodeDimensions(current);

    for (let j = 0; j < i; j += 1) {
      const previous = result[j];
      const previousSize = nodeDimensions(previous);

      const overlapX =
        current.position.x < previous.position.x + previousSize.width
        && current.position.x + currentSize.width > previous.position.x;
      const overlapY =
        current.position.y < previous.position.y + previousSize.height
        && current.position.y + currentSize.height > previous.position.y;

      if (!overlapX || !overlapY) continue;

      current.position.y =
        previous.position.y + previousSize.height + COLLISION_GAP;
    }
  }

  return result;
}

/**
 * Workflow 自动布局：纵向阅读，但主线做轻微 S 型摆动，分支向两侧“长出来”。
 *
 * 视觉上看起来更像工作地图，而不是 BPMN 式的一根长线：
 *
 *          [A]
 *             ↓
 *                  [B]
 *             ↓
 *          [C]      ↙ branch
 *        ↙
 *      [D]
 *         ↓
 *            [E]
 *
 * 成功出口仍然从底部到顶部，因此不需要改变 X6 Port 语义。
 */
export function layoutWorkflow(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  if (!nodes.length) return [];

  const ranks = calculateWorkflowRanks(nodes, edges);
  const mainFlow = findMainFlowNodes(nodes, edges);
  const lanes = assignLanes(nodes, edges, ranks, mainFlow);

  const laidOut = nodes.map((node) => {
    const rank = ranks.get(node.id) ?? 0;
    const lane = lanes.get(node.id) ?? 0;

    return copyNode(
      node,
      MAIN_X + lane * LANE_GAP,
      MAIN_Y + rank * ROW_GAP,
    );
  });

  const minX = Math.min(...laidOut.map((node) => node.position.x));
  const minY = Math.min(...laidOut.map((node) => node.position.y));
  const normalized = laidOut.map((node) =>
    copyNode(
      node,
      node.position.x + Math.max(0, CANVAS_PADDING - minX),
      node.position.y + Math.max(0, CANVAS_PADDING - minY),
    ),
  );

  return removeNodeCollisions(normalized);
}

/** 旧函数名保留，避免已有调用方一次性修改；实现不再依赖 ELK。 */
export function layoutWithElk(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Promise<FlowNode[]> {
  return Promise.resolve(layoutWorkflow(nodes, edges));
}

/** 兼容旧调用方；不再二次压平。 */
export function enforceWorkflowReadingOrder(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  return layoutWorkflow(nodes, edges);
}

export async function autoLayoutJourney(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Promise<FlowNode[]> {
  return layoutWorkflow(nodes, edges);
}

export function workflowLayoutEngine(): WorkflowLayout['engine'] {
  return WORKFLOW_LAYOUT_ENGINE;
}
