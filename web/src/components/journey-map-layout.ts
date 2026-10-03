import ELK from 'elkjs/lib/elk.bundled.js';
import type { FlowEdge, FlowNode } from './journey-map-types.js';

const elk = new ELK();

/**
 * Workflow 节点的“保守估计高度”。
 *
 * React Flow 12 的真实尺寸在 measured.width / measured.height 中；
 * 但第一次布局时节点还可能没有完成测量。
 * 因此这里永远使用一个足够保守的 fallback，避免 ELK 按“小卡片”排版，
 * React Flow 真正渲染后卡片变高，最终彼此压住。
 */
const FALLBACK_NODE_WIDTH = 236;
const FALLBACK_NODE_HEIGHT = 220;
const TERMINAL_NODE_WIDTH = 190;
const TERMINAL_NODE_HEIGHT = 96;

/**
 * 用户明确要求“不要贴着”。
 *
 * ELK 的 node-node spacing 是最小安全距离，不是视觉上的“宽松程度”。
 * 对当前 230px 左右的卡片，140px 左右的额外留白比较合适。
 */
const NODE_GAP = 160;
const LAYER_GAP = 220;
const EDGE_NODE_GAP = 80;
const EDGE_EDGE_GAP = 60;
const BRANCH_VERTICAL_GAP = 120;

/** 给布局引擎提供真实/保守的节点尺寸。 */
function nodeDimensions(node: FlowNode): { width: number; height: number } {
  const terminal = node.data.nodeType === 'end' || node.data.nodeType === 'stop';

  if (terminal) {
    return {
      width: TERMINAL_NODE_WIDTH,
      height: TERMINAL_NODE_HEIGHT,
    };
  }

  return {
    width: Math.max(
      FALLBACK_NODE_WIDTH,
      Number(node.measured?.width ?? node.style?.width ?? FALLBACK_NODE_WIDTH),
    ),
    height: Math.max(
      FALLBACK_NODE_HEIGHT,
      Number(node.measured?.height ?? FALLBACK_NODE_HEIGHT) + 28,
    ),
  };
}

/**
 * ELK 本身负责图的 layered layout。
 *
 * 关键点：
 * 1. 不能再硬编码 128px 高度；
 * 2. 使用 ports + FIXED_ORDER，减少多分支 crossing；
 * 3. RIGHT 让流程整体从左到右；
 * 4. 大间距让自动排版结果首先“可读”，而不是首先“塞进画布”。
 *
 * 注意：React Flow 最终绘制的是自定义 SmoothStep edge，因此这里的 edgeRouting
 * 主要帮助 ELK 评估 graph layout，不把 ELK 的 SVG path 直接拿到前端画布。
 */
export async function layoutWithElk(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Promise<FlowNode[]> {
  const graph = {
    id: 'journey-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',

      // 节点之间的真正安全距离。
      'elk.spacing.nodeNode': String(NODE_GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(EDGE_NODE_GAP),
      'elk.layered.spacing.edgeEdgeBetweenLayers': String(EDGE_EDGE_GAP),
      'elk.spacing.componentComponent': '180',

      // 让 crossing minimization 有足够机会调整 branch 顺序。
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',

      // 给整个图留一点“边界空气”，避免节点贴着布局边缘。
      'elk.padding': '[top=40,left=40,bottom=40,right=40]',
    },

    children: nodes.map((node) => {
      const dimensions = nodeDimensions(node);

      return {
        id: node.id,
        width: dimensions.width,
        height: dimensions.height,

        ports: [
          ...node.data.targetHandles.map((handle) => ({
            id: handle.id,
            properties: {
              side: 'WEST',
            },
          })),
          ...node.data.sourceHandles.map((handle) => ({
            id: handle.id,
            properties: {
              side: 'EAST',
            },
          })),
        ],

        properties: {
          // React Flow 官方 Multiple Handles 示例就是靠这个减少 edge crossing。
          'org.eclipse.elk.portConstraints': 'FIXED_ORDER',
        },
      };
    }),

    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.sourceHandle ?? edge.source],
      targets: [edge.targetHandle ?? edge.target],
    })),
  } as unknown as Parameters<typeof elk.layout>[0];

  const result = await elk.layout(graph);
  const children = result.children ?? [];

  const positions = new Map(
    children.map((child) => [
      child.id,
      {
        x: child.x ?? 0,
        y: child.y ?? 0,
      },
    ]),
  );

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }));
}

/**
 * 计算 Workflow 的左→右层级。
 *
 * 这不是第二套布局算法，而是对 ELK 结果增加 Workflow 语义约束：
 * “前一步一定在后一步左边”。
 * 有环时最多迭代 N 次，避免异常 Workflow 把 x 坐标无限推远。
 */
function calculateFlowRanks(nodes: FlowNode[], edges: FlowEdge[]): Map<string, number> {
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const incoming = new Map<string, number>();

  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  // 优先把真正的起点放到第 0 层；如果图没有显式 start，使用入度为 0 的节点。
  const starts = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.position.x - b.position.x);

  if (starts.length) {
    for (const node of nodes) ranks.set(node.id, Number.POSITIVE_INFINITY);
    ranks.set(starts[0].id, 0);

    // 其它 disconnected source 仍然需要可布局，因此回填到 0。
    for (const node of starts.slice(1)) ranks.set(node.id, 0);
  }

  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;

    for (const edge of edges) {
      const sourceRank = ranks.get(edge.source) ?? 0;
      const targetRank = ranks.get(edge.target) ?? 0;
      const nextRank = Math.min(nodes.length - 1, sourceRank + 1);

      if (Number.isFinite(sourceRank) && nextRank > targetRank) {
        ranks.set(edge.target, nextRank);
        changed = true;
      }
    }

    if (!changed) break;
  }

  for (const node of nodes) {
    if (!Number.isFinite(ranks.get(node.id))) ranks.set(node.id, 0);
  }

  return ranks;
}

/**
 * 在 ELK 结果上增加工作地图自己的“阅读顺序”。
 *
 * 目标非常明确：
 *
 *   start ──> 主步骤 ──> 主步骤 ──> end
 *                       │
 *                       ├── 分支 A（右上）
 *                       └── 分支 B（右下）
 *
 * 也就是说：
 * - 起点尽量最左；
 * - 后继步骤一定比前一步更靠右；
 * - 一个节点产生多个出口时，它本身作为“主步骤”，分支目标放到右上/右下；
 * - 分支目标围绕主步骤垂直展开，而不是把主步骤挤到最上面；
 * - terminal 最终统一推到最右侧。
 *
 * ELK 仍然负责复杂图的 crossing minimization；这里负责的是产品层面的阅读习惯。
 */
function enforceWorkflowReadingOrder(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  if (nodes.length <= 1) return nodes;

  const ranks = calculateFlowRanks(nodes, edges);
  const dimensions = new Map(nodes.map((node) => [node.id, nodeDimensions(node)]));
  const outgoing = new Map<string, FlowEdge[]>();

  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }

  const rankWidth = new Map<number, number>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    rankWidth.set(rank, Math.max(rankWidth.get(rank) ?? 0, dimensions.get(node.id)?.width ?? FALLBACK_NODE_WIDTH));
  }

  const rankX = new Map<number, number>();
  let x = 0;
  const maxRank = Math.max(...Array.from(ranks.values()));
  for (let rank = 0; rank <= maxRank; rank += 1) {
    rankX.set(rank, x);
    x += (rankWidth.get(rank) ?? FALLBACK_NODE_WIDTH) + LAYER_GAP;
  }

  const result = nodes.map((node) => ({
    ...node,
    position: {
      x: rankX.get(ranks.get(node.id) ?? 0) ?? node.position.x,
      y: node.position.y,
    },
  }));

  const resultById = new Map(result.map((node) => [node.id, node]));

  // 分支布局：以主步骤的 y 为中心，上下交替摆放出口目标。
  for (const source of nodes) {
    const branchEdges = outgoing.get(source.id) ?? [];
    if (branchEdges.length < 2) continue;

    const main = resultById.get(source.id);
    if (!main) continue;

    const sourceHeight = dimensions.get(source.id)?.height ?? FALLBACK_NODE_HEIGHT;
    const orderedBranches = [...branchEdges].sort((a, b) => {
      const aNode = resultById.get(a.target);
      const bNode = resultById.get(b.target);
      return (aNode?.position.y ?? 0) - (bNode?.position.y ?? 0);
    });

    const spacing = Math.max(
      sourceHeight / 2 + BRANCH_VERTICAL_GAP,
      FALLBACK_NODE_HEIGHT + NODE_GAP,
    );
    const center = (orderedBranches.length - 1) / 2;

    orderedBranches.forEach((edge, index) => {
      const target = resultById.get(edge.target);
      if (!target) return;

      const targetHeight = dimensions.get(edge.target)?.height ?? FALLBACK_NODE_HEIGHT;
      const relative = index - center;

      target.position = {
        x: Math.max(target.position.x, main.position.x + (dimensions.get(source.id)?.width ?? FALLBACK_NODE_WIDTH) + LAYER_GAP),
        y: main.position.y + relative * Math.max(spacing, targetHeight + NODE_GAP),
      };
    });
  }

  // 强制所有 terminal 在最右侧，避免某个分支提前结束导致 end 落在中间。
  const terminalNodes = result.filter(
    (node) => node.data.nodeType === 'end' || node.data.nodeType === 'stop',
  );

  if (terminalNodes.length) {
    const maxNonTerminalX = Math.max(
      ...result
        .filter((node) => node.data.nodeType !== 'end' && node.data.nodeType !== 'stop')
        .map((node) => node.position.x),
    );
    const terminalX = maxNonTerminalX + LAYER_GAP + FALLBACK_NODE_WIDTH;

    terminalNodes.forEach((node) => {
      node.position = {
        x: Math.max(node.position.x, terminalX),
        y: node.position.y,
      };
    });
  }

  return result;
}

/**
 * ELK 已经保证 graph layout 基本不重叠，但 Workflow Editor 的视觉卡片高度
 * 还包含 React Flow/Ant Design 的真实 CSS 内容。
 *
 * 这里再做一次非常保守的“只向下推”的碰撞消除：
 * - 不改变 ELK 给出的 layer/x；
 * - 只处理同一区域里实际碰撞的节点；
 * - 每个节点至少保留 NODE_GAP 的纵向呼吸空间。
 *
 * 它不是第二个布局算法，而是最后一道安全保险。
 */
export function removeNodeCollisions(nodes: FlowNode[]): FlowNode[] {
  const ordered = [...nodes].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
  );

  const placed: Array<{ node: FlowNode; width: number; height: number }> = [];

  for (const node of ordered) {
    const dimensions = nodeDimensions(node);
    let y = node.position.y;

    for (const previous of placed) {
      const xOverlaps =
        node.position.x < previous.node.position.x + previous.width + NODE_GAP
        && node.position.x + dimensions.width + NODE_GAP > previous.node.position.x;

      if (!xOverlaps) continue;

      const minY = previous.node.position.y + previous.height + NODE_GAP;

      if (y < minY && y + dimensions.height > previous.node.position.y - NODE_GAP) {
        y = minY;
      }
    }

    const adjusted = {
      ...node,
      position: {
        x: node.position.x,
        y,
      },
    };

    placed.push({
      node: adjusted,
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  return ordered.map(
    (node) => placed.find((item) => item.node.id === node.id)?.node ?? node,
  );
}

/**
 * 对外唯一入口。
 *
 * 自动排版按钮、创建节点后的重排、连接变化后的重排都必须走这里，
 * 避免三个地方各写一套“排版规则”，最后出现不同结果。
 */
export async function autoLayoutJourney(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Promise<FlowNode[]> {
  const layouted = await layoutWithElk(nodes, edges);
  const ordered = enforceWorkflowReadingOrder(layouted, edges);
  return removeNodeCollisions(ordered);
}
