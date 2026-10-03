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
const FALLBACK_NODE_HEIGHT = 190;
const TERMINAL_NODE_WIDTH = 190;
const TERMINAL_NODE_HEIGHT = 96;

/**
 * 用户明确要求“不要贴着”。
 *
 * ELK 的 node-node spacing 是最小安全距离，不是视觉上的“宽松程度”。
 * 对当前 230px 左右的卡片，140px 左右的额外留白比较合适。
 */
const NODE_GAP = 140;
const LAYER_GAP = 200;
const EDGE_NODE_GAP = 80;
const EDGE_EDGE_GAP = 60;

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
      Number(node.measured?.height ?? FALLBACK_NODE_HEIGHT) + 20,
    ),
  };
}

/**
 * ELK 本身负责图的 layered layout。
 *
 * 关键点：
 * 1. 不能再硬编码 128px 高度；
 * 2. 使用 ports + FIXED_ORDER，减少多分支 crossing；
 * 3. RIGHT + ORTHOGONAL，让流程整体从左到右；
 * 4. 大间距让自动排版结果首先“可读”，而不是首先“塞进画布”。
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
  return removeNodeCollisions(layouted);
}
