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
const FALLBACK_NODE_HEIGHT = 180;
const TERMINAL_NODE_WIDTH = 190;
const TERMINAL_NODE_HEIGHT = 96;

/**
 * 用户明确要求“不要贴着”。
 *
 * ELK 的 node-node spacing 是最小安全距离，不是视觉上的“宽松程度”。
 * 对当前 230px 左右的卡片，140px 左右的额外留白比较合适。
 */
const NODE_GAP = 56;
const LAYER_GAP = 72;
const EDGE_NODE_GAP = 40;
const EDGE_EDGE_GAP = 40;
const BRANCH_VERTICAL_GAP = 72;

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

  // 自动排版最终以“主流程居中、分支轻量展开”为目标。
  // 先记录 ELK 的结果，再统一消掉整体 Y 偏移，避免保存/恢复后整张图漂在视口顶部或底部。
  const ys = children.map((child) => child.y ?? 0);
  const minY = ys.length ? Math.min(...ys) : 0;
  const normalizeY = minY;

  return nodes.map((node) => ({
    ...node,
    position: (() => {
      const position = positions.get(node.id) ?? node.position;
      return {
        x: position.x,
        y: position.y - normalizeY,
      };
    })(),
  }));
}

/**
 * 计算 Workflow 的左→右层级。
 *
 * 这不是第二套布局算法，而是对 ELK 结果增加 Workflow 语义约束：
 * “前一步一定在后一步左边”。
 * 有环时最多迭代 N 次，避免异常 Workflow 把 x 坐标无限推远。
 */
/**
 * 为布局提取“向前走”的边。
 *
 * Workflow 可能存在 retry / return 这种回到前面步骤的边。这样的边在视觉上允许向左，
 * 但不能参与主布局层级计算，否则一个回路线就会把整张图的 x 顺序拖乱。
 */
function isLikelyBackwardRoute(edge: FlowEdge): boolean {
  const outcome = String(edge.data?.outcome ?? '').trim().toLowerCase();
  return /(^|[-_\s])(retry|return|rollback|back|previous|prev|reopen|again)([-_\s]|$)/i.test(outcome)
    || /(重试|退回|回退|返回|回滚|重新)/.test(outcome);
}

/**
 * 找布局主流程时，优先沿“正常前进”出口深入。
 *
 * Workflow 可能存在 retry / return 这种回到前面步骤的边。
 * DFS 如果无视出口语义，很容易把一条普通分支误选成 cycle back-edge。
 * 这里把明显的回退出口排到最后，让 cycle breaking 更贴近业务阅读顺序。
 */
function getForwardLayoutEdges(nodes: FlowNode[], edges: FlowEdge[]): FlowEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, FlowEdge[]>();

  for (const edge of edges) {
    if (
      edge.source === edge.target
      || !nodeIds.has(edge.source)
      || !nodeIds.has(edge.target)
    ) {
      continue;
    }

    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge]);
  }

  for (const [source, sourceEdges] of adjacency) {
    sourceEdges.sort((a, b) => {
      const backwardDelta = Number(isLikelyBackwardRoute(a)) - Number(isLikelyBackwardRoute(b));
      if (backwardDelta !== 0) return backwardDelta;

      const aPrimary = /^(success|done|pass|complete|completed|next)$/.test(String(a.data?.outcome ?? '').trim().toLowerCase());
      const bPrimary = /^(success|done|pass|complete|completed|next)$/.test(String(b.data?.outcome ?? '').trim().toLowerCase());
      const primaryDelta = Number(bPrimary) - Number(aPrimary);
      if (primaryDelta !== 0) return primaryDelta;

      return a.target.localeCompare(b.target);
    });
    adjacency.set(source, sourceEdges);
  }

  // 通过 DFS 识别回边。回边不参与“source 必须在 target 左侧”的层级约束。
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const backEdges = new Set<string>();

  const visit = (nodeId: string) => {
    visiting.add(nodeId);

    for (const edge of adjacency.get(nodeId) ?? []) {
      if (visiting.has(edge.target)) {
        backEdges.add(edge.id);
        continue;
      }
      if (!visited.has(edge.target)) visit(edge.target);
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  // 有入度为 0 的节点时优先从它开始；通常就是 Workflow start。
  const incoming = new Set<string>();
  for (const edge of adjacency.values()) {
    for (const item of edge) incoming.add(item.target);
  }

  const roots = nodes
    .filter((node) => !incoming.has(node.id))
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);

  for (const root of roots) {
    if (!visited.has(root.id)) visit(root.id);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) visit(node.id);
  }

  return edges.filter(
    (edge) =>
      edge.source !== edge.target
      && nodeIds.has(edge.source)
      && nodeIds.has(edge.target)
      && !backEdges.has(edge.id),
  );
}

/**
 * 计算每个节点的左→右层级。
 *
 * 规则：
 * - 起点从第 0 层开始；
 * - 每条“向前”的边都会让 target 至少比 source 多一层；
 * - 同一层表示同一个流程深度，主路线和分支会在同一列；
 * - retry / return 回边不参与层级计算，避免循环把布局无限推向右边。
 */
function calculateFlowRanks(nodes: FlowNode[], edges: FlowEdge[]): Map<string, number> {
  const forwardEdges = getForwardLayoutEdges(nodes, edges);
  const incomingCount = new Map<string, number>();

  for (const edge of forwardEdges) {
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  const roots = nodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);

  const ranks = new Map(nodes.map((node) => [node.id, Number.POSITIVE_INFINITY]));

  for (const root of roots) {
    if (!Number.isFinite(ranks.get(root.id))) {
      ranks.set(root.id, 0);
    }
  }

  // 对每条向前边做最长路径传播。DAG 中 N 次足够收敛；存在异常图时 N 次后停止。
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;

    for (const edge of forwardEdges) {
      const sourceRank = ranks.get(edge.source);
      if (!Number.isFinite(sourceRank)) continue;

      const targetRank = ranks.get(edge.target) ?? Number.POSITIVE_INFINITY;
      const nextRank = Number(sourceRank) + 1;

      if (nextRank < targetRank) {
        ranks.set(edge.target, nextRank);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 完全孤立/异常循环节点也必须能显示出来。
  for (const node of nodes) {
    if (!Number.isFinite(ranks.get(node.id))) {
      ranks.set(node.id, 0);
    }
  }

  return ranks;
}

/** 判断 outcome 是否更像主流程出口。 */
function isPrimaryRoute(edge: FlowEdge): boolean {
  const outcome = String(edge.data?.outcome ?? '').trim().toLowerCase();
  return ['success', 'done', 'pass', 'complete', 'completed', 'next'].includes(outcome);
}

/**
 * 在 ELK 结果上增加工作地图自己的“阅读顺序”。
 *
 * 规则：
 * - start 在最左；
 * - 正常前进边 source 一定在 target 左边；
 * - 一个节点有多个出口时，主出口目标在中间；
 * - 其它分支目标放在主出口上方 / 下方，并且保持在右侧；
 * - terminal 统一放到最右边。
 */
export function enforceWorkflowReadingOrder(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  if (nodes.length <= 1) return nodes;

  const ranks = calculateFlowRanks(nodes, edges);
  const dimensions = new Map(nodes.map((node) => [node.id, nodeDimensions(node)]));
  const forwardEdges = getForwardLayoutEdges(nodes, edges);
  const outgoing = new Map<string, FlowEdge[]>();

  for (const edge of forwardEdges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }

  const rankWidth = new Map<number, number>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    rankWidth.set(
      rank,
      Math.max(
        rankWidth.get(rank) ?? 0,
        dimensions.get(node.id)?.width ?? FALLBACK_NODE_WIDTH,
      ),
    );
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

  // 多出口：主出口保持在 source 的 y 中心，分支出口分到上/下。
  for (const source of nodes) {
    const sourceEdges = outgoing.get(source.id) ?? [];
    if (sourceEdges.length < 2) continue;

    const main = resultById.get(source.id);
    if (!main) continue;

    const sourceHeight = dimensions.get(source.id)?.height ?? FALLBACK_NODE_HEIGHT;

    const ordered = [...sourceEdges].sort((a, b) => {
      const primaryDelta = Number(isPrimaryRoute(b)) - Number(isPrimaryRoute(a));
      if (primaryDelta !== 0) return primaryDelta;

      const aTarget = resultById.get(a.target);
      const bTarget = resultById.get(b.target);
      return (aTarget?.position.y ?? 0) - (bTarget?.position.y ?? 0);
    });

    const primary = ordered[0];
    const branchEdges = ordered.slice(1);
    const primaryTarget = resultById.get(primary.target);

    if (primaryTarget) {
      primaryTarget.position.y = main.position.y;
    }

    const verticalStep = Math.max(
      sourceHeight + BRANCH_VERTICAL_GAP,
      FALLBACK_NODE_HEIGHT + NODE_GAP,
    );

    branchEdges.forEach((edge, index) => {
      const target = resultById.get(edge.target);
      if (!target) return;

      const direction = index % 2 === 0 ? -1 : 1;
      const distance = Math.floor(index / 2) + 1;
      target.position = {
        x: Math.max(
          target.position.x,
          main.position.x
            + (dimensions.get(source.id)?.width ?? FALLBACK_NODE_WIDTH)
            + LAYER_GAP,
        ),
        y: main.position.y + direction * distance * verticalStep,
      };
    });
  }

  // 再做一次硬约束：所有正常 forward edge 的 target 至少位于 source 右侧。
  // 不依赖 ELK 的偶然排序，直接保证工作地图不会出现“出口连到左边”的明显错误。
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;

    for (const edge of forwardEdges) {
      const source = resultById.get(edge.source);
      const target = resultById.get(edge.target);
      if (!source || !target) continue;

      const sourceWidth =
        dimensions.get(edge.source)?.width ?? FALLBACK_NODE_WIDTH;
      const targetX = source.position.x + sourceWidth + LAYER_GAP;

      if (target.position.x < targetX) {
        target.position.x = targetX;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // terminal 必须放到整个正常流程的最右侧。
  const terminalNodes = result.filter(
    (node) => node.data.nodeType === 'end' || node.data.nodeType === 'stop',
  );

  if (terminalNodes.length) {
    const nonTerminalRight = Math.max(
      0,
      ...result
        .filter((node) => node.data.nodeType !== 'end' && node.data.nodeType !== 'stop')
        .map((node) => {
          const width = dimensions.get(node.id)?.width ?? FALLBACK_NODE_WIDTH;
          return node.position.x + width;
        }),
    );

    const terminalX = nonTerminalRight + LAYER_GAP;

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
