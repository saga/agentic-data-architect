import React, { useEffect, useMemo, useState } from 'react';
import {
  AimOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  LockOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { Button, Empty, Flex, Tag, Typography } from 'antd';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';

const { Text } = Typography;

export interface JourneyMapStage {
  id: string;
  title: string;
  objective: string;
  status: 'completed' | 'current' | 'locked' | 'future';
  nodeType: string;
  unlocked: boolean;
}

export interface JourneyMapRoute {
  id: string;
  title: string;
  reason: string;
  steps: string[];
}

interface JourneyMapProps {
  journey?: {
    stages: JourneyMapStage[];
  };
  routes?: JourneyMapRoute[];
  loading?: boolean;
  onChooseRoute?: (route: JourneyMapRoute) => void;
  onAskStage?: (stage: JourneyMapStage) => void;
}

type JourneyFlowNodeData = {
  title: string;
  subtitle?: string;
  status?: JourneyMapStage['status'];
  statusLabel?: string;
  kind: 'stage' | 'route';
  nodeType?: string;
  route?: JourneyMapRoute;
  stage?: JourneyMapStage;
  action?: React.ReactNode;
};

type JourneyFlowNode = Node<JourneyFlowNodeData>;

const NODE_GAP = 34;
const STAGE_WIDTH = 204;
const CURRENT_STAGE_WIDTH = 250;
const ROUTE_WIDTH = 292;

const STATUS_META: Record<
  JourneyMapStage['status'],
  {
    label: string;
    icon: React.ReactNode;
  }
> = {
  completed: {
    label: '已完成',
    icon: <CheckCircleFilled />,
  },
  current: {
    label: '现在进行中',
    icon: <AimOutlined />,
  },
  future: {
    label: '下一阶段',
    icon: <ClockCircleOutlined />,
  },
  locked: {
    label: '暂不可走',
    icon: <LockOutlined />,
  },
};

const NODE_TYPE_LABEL: Record<string, string> = {
  task: '任务',
  gate: '判断点',
  review: '评审',
  end: '完成',
  stop: '停止',
};

function stageWidth(stage: JourneyMapStage) {
  return stage.status === 'current' ? CURRENT_STAGE_WIDTH : STAGE_WIDTH;
}

function routeHeight(route: JourneyMapRoute) {
  return Math.min(188, 116 + Math.min(route.steps.length, 3) * 22);
}

function stageNode(stage: JourneyMapStage, onAskStage?: JourneyMapProps['onAskStage']): JourneyFlowNode {
  const meta = STATUS_META[stage.status];
  const canContinue = stage.status === 'current' || (stage.status === 'future' && stage.unlocked);

  return {
    id: `stage:${stage.id}`,
    position: { x: 0, y: 0 },
    draggable: false,
    selectable: false,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      kind: 'stage',
      stage,
      status: stage.status,
      title: stage.title,
      subtitle: stage.objective,
      statusLabel: meta.label,
      nodeType: stage.nodeType,
      action: canContinue && onAskStage ? (
        <Button
          type="primary"
          size="small"
          icon={<ArrowRightOutlined />}
          className="journey-node-toolbar-button nodrag nopan"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => onAskStage(stage)}
        >
          围绕此阶段继续
        </Button>
      ) : undefined,
    },
    style: {
      width: stageWidth(stage),
      minHeight: stage.status === 'current' ? 132 : 104,
    },
    className: `journey-flow-node journey-flow-node-stage journey-flow-node-${stage.status}`,
  };
}

function routeNode(
  route: JourneyMapRoute,
  index: number,
  onChooseRoute?: JourneyMapProps['onChooseRoute'],
): JourneyFlowNode {
  return {
    id: `route:${route.id}`,
    position: { x: 0, y: 0 },
    draggable: false,
    selectable: false,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: {
      kind: 'route',
      route,
      title: route.title,
      subtitle: route.reason,
      statusLabel: `Agent 建议 ${index + 1}`,
      action: onChooseRoute ? (
        <Button
          type="primary"
          size="small"
          icon={<ArrowRightOutlined />}
          className="journey-route-action nodrag nopan"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => onChooseRoute(route)}
        >
          采用这条路线
        </Button>
      ) : undefined,
    },
    style: {
      width: ROUTE_WIDTH,
      minHeight: routeHeight(route),
    },
    className: 'journey-flow-node journey-flow-node-route',
  };
}

function buildGraph(
  journey: JourneyMapProps['journey'],
  routes: JourneyMapRoute[],
  onChooseRoute?: JourneyMapProps['onChooseRoute'],
  onAskStage?: JourneyMapProps['onAskStage'],
) {
  const stages = journey?.stages ?? [];
  const nodes: JourneyFlowNode[] = stages.map((stage) => stageNode(stage, onAskStage));
  const edges: Edge[] = [];

  if (!stages.length && routes.length) {
    const fallbackStage: JourneyMapStage = {
      id: 'current',
      title: '当前调查',
      objective: '没有固定 Workflow，路线由当前目标、证据和用户动作决定。',
      status: 'current',
      nodeType: 'task',
      unlocked: true,
    };
    nodes.push(stageNode(fallbackStage, onAskStage));
  }

  const visibleStages = stages.length
    ? stages
    : [{
      id: 'current',
      title: '当前调查',
      objective: '没有固定 Workflow，路线由当前目标、证据和用户动作决定。',
      status: 'current' as const,
      nodeType: 'task',
      unlocked: true,
    }];

  visibleStages.forEach((stage, index) => {
    if (index === 0) return;

    const previous = visibleStages[index - 1];
    const traversed = previous.status === 'completed' || stage.status === 'completed';
    const currentTransition = previous.status === 'current' || stage.status === 'current';

    edges.push({
      id: `stage-edge:${previous.id}:${stage.id}`,
      source: `stage:${previous.id}`,
      target: `stage:${stage.id}`,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: currentTransition,
      className: [
        'journey-flow-edge',
        traversed ? 'journey-flow-edge-traversed' : '',
        currentTransition && !traversed ? 'journey-flow-edge-current' : '',
      ].filter(Boolean).join(' '),
    });
  });

  const anchorStage =
    visibleStages.find((stage) => stage.status === 'current') ??
    [...visibleStages].reverse().find((stage) => stage.status === 'completed') ??
    visibleStages[0];

  const anchorIndex = Math.max(0, visibleStages.findIndex((stage) => stage.id === anchorStage.id));
  const anchorX = visibleStages.slice(0, anchorIndex + 1).reduce(
    (x, stage) => x + stageWidth(stage) + NODE_GAP,
    0,
  ) - stageWidth(anchorStage) - NODE_GAP;

  routes.slice(0, 3).forEach((route, routeIndex) => {
    const node = routeNode(route, routeIndex, onChooseRoute);
    const centeredOffset = (routeIndex - (Math.min(routes.length, 3) - 1) / 2) * (ROUTE_WIDTH + 24);
    node.position = {
      x: anchorX + centeredOffset,
      y: 220,
    };
    nodes.push(node);

    edges.push({
      id: `route-anchor:${route.id}`,
      source: `stage:${anchorStage.id}`,
      target: node.id,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: true,
      className: 'journey-flow-edge journey-flow-edge-suggested',
    });
  });

  // The backbone is deterministic; route suggestions branch from the actual current point.
  let x = 0;
  for (const node of nodes) {
    if (node.data.kind !== 'stage') continue;
    const stage = node.data.stage;
    if (!stage) continue;
    node.position = {
      x,
      y: 40,
    };
    x += stageWidth(stage) + NODE_GAP;
  }

  // Re-anchor suggestion cards after the main line has been positioned.
  const actualAnchorX = Math.max(
    0,
    visibleStages.slice(0, anchorIndex).reduce(
      (sum, stage) => sum + stageWidth(stage) + NODE_GAP,
      0,
    ),
  ) + stageWidth(anchorStage) / 2;

  nodes
    .filter((node) => node.data.kind === 'route')
    .forEach((node, index, routeNodes) => {
      const offset = (index - (routeNodes.length - 1) / 2) * (ROUTE_WIDTH + 24);
      node.position = {
        x: actualAnchorX - ROUTE_WIDTH / 2 + offset,
        y: 222,
      };
    });

  return { nodes, edges, currentStage: anchorStage };
}

function JourneyNode({ data }: NodeProps) {
  const nodeData = data as JourneyFlowNodeData;

  if (nodeData.kind === 'route') {
    const route = nodeData.route;
    return (
      <>
        <Handle type="target" position={Position.Top} className="journey-flow-handle" />
        <div className="journey-flow-node-content journey-flow-route-content">
          <div className="journey-flow-node-kicker journey-flow-node-kicker-route">
            <BranchesOutlined />
            <span>{nodeData.statusLabel}</span>
          </div>
          <div className="journey-flow-node-title journey-flow-route-title">{nodeData.title}</div>
          <div className="journey-flow-node-subtitle">{nodeData.subtitle}</div>
          {route?.steps.length ? (
            <div className="journey-route-steps">
              {route.steps.slice(0, 3).map((step, index) => (
                <div className="journey-route-step" key={`${route.id}-${index}`}>
                  <span className="journey-route-step-index">{index + 1}</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="journey-flow-route-footer">
            <Text type="secondary">新证据出现后，Agent 可能重新规划</Text>
            {nodeData.action}
          </div>
        </div>
      </>
    );
  }

  const status = nodeData.status ?? 'future';
  const meta = STATUS_META[status];

  return (
    <>
      {status === 'current' ? (
        <NodeToolbar isVisible position={Position.Top} offset={12} className="journey-node-toolbar">
          {nodeData.action}
        </NodeToolbar>
      ) : null}
      <Handle type="target" position={Position.Left} className="journey-flow-handle" />
      <div className="journey-flow-node-content journey-flow-stage-content">
        <div className={`journey-flow-node-kicker journey-flow-node-kicker-${status}`}>
          {meta.icon}
          <span>{meta.label}</span>
          {nodeData.nodeType ? <span className="journey-flow-node-type">{NODE_TYPE_LABEL[nodeData.nodeType] ?? nodeData.nodeType}</span> : null}
        </div>
        <div className="journey-flow-node-title">{nodeData.title}</div>
        {status === 'current' ? (
          <div className="journey-flow-node-subtitle journey-flow-node-subtitle-current">{nodeData.subtitle}</div>
        ) : (
          <div className="journey-flow-node-subtitle">{nodeData.subtitle}</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="journey-flow-handle" />
    </>
  );
}

const nodeTypes = {
  default: JourneyNode,
};

export function JourneyMap({
  journey,
  routes = [],
  loading = false,
  onChooseRoute,
  onAskStage,
}: JourneyMapProps) {
  const graph = useMemo(
    () => buildGraph(journey, routes, onChooseRoute, onAskStage),
    [journey, routes, onChooseRoute, onAskStage],
  );
  const [nodes, setNodes] = useState<JourneyFlowNode[]>(graph.nodes);
  const [layouting, setLayouting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNodes(graph.nodes);
    setLayouting(true);

    // Mainline positions are deterministic; ELK is intentionally retained only as a safe
    // fallback for future graph expansion. The current work-map intentionally reads as a
    // roadmap rather than an arbitrary node graph.
    Promise.resolve().then(() => {
      if (!cancelled) setLayouting(false);
    });

    return () => {
      cancelled = true;
    };
  }, [graph]);

  if (!graph.nodes.length || loading) {
    return (
      <div className="journey-map-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={loading ? '正在整理工作地图…' : '还没有足够的信息生成工作地图。'}
        />
      </div>
    );
  }

  const totalStages = graph.currentStage ? (journey?.stages.length ?? 1) : 0;
  const completedStages = journey?.stages.filter((stage) => stage.status === 'completed').length ?? 0;
  const routeCount = Math.min(routes.length, 3);

  return (
    <div className="journey-map-canvas">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        colorMode="light"
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.72, maxZoom: 1.18 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          gap={22}
          size={1}
          variant={BackgroundVariant.Dots}
          color="#dfe5ee"
        />

        <Panel position="top-left" className="journey-map-heading-panel">
          <div className="journey-map-heading">
            <div className="journey-map-heading-icon">
              <BranchesOutlined />
            </div>
            <div>
              <div className="journey-map-heading-title">调查主线</div>
              <div className="journey-map-heading-subtitle">
                主线是当前 Workflow 的骨架；下面的分支是 Agent 针对当前证据给出的临时路线。
              </div>
            </div>
          </div>
        </Panel>

        <Panel position="top-right" className="journey-map-summary-panel">
          <div className="journey-map-summary">
            <div className="journey-map-summary-eyebrow">当前进度</div>
            <div className="journey-map-summary-title">{graph.currentStage?.title ?? '当前调查'}</div>
            <Flex gap={6} wrap>
              <Tag bordered={false}>{completedStages}/{Math.max(totalStages, 1)} 已完成</Tag>
              {routeCount ? <Tag bordered={false} color="blue">{routeCount} 条 Agent 建议</Tag> : null}
            </Flex>
          </div>
        </Panel>

        <Panel position="bottom-left" className="journey-map-legend">
          <Flex gap={10} wrap>
            <span className="journey-map-legend-item journey-map-legend-completed"><span />已完成</span>
            <span className="journey-map-legend-item journey-map-legend-current"><span />当前</span>
            <span className="journey-map-legend-item journey-map-legend-future"><span />待进入</span>
            <span className="journey-map-legend-item journey-map-legend-suggested"><span />Agent 建议</span>
            {layouting ? <Tag bordered={false}>正在更新地图…</Tag> : null}
          </Flex>
        </Panel>

        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(node) => {
            const nodeData = node.data as JourneyFlowNodeData;
            if (nodeData.kind === 'route') return '#1677ff';
            if (nodeData.status === 'completed') return '#52c41a';
            if (nodeData.status === 'current') return '#1677ff';
            if (nodeData.status === 'locked') return '#d9d9d9';
            return '#b5c0cf';
          }}
          nodeStrokeWidth={3}
          maskColor="rgba(247, 249, 252, 0.76)"
        />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
