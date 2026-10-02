import React, { useEffect, useMemo, useState } from 'react';
import ELK from 'elkjs/lib/elk.bundled.js';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Button, Empty, Flex, Tag, Typography } from 'antd';

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
}

type JourneyFlowNodeData = {
  title: string;
  subtitle?: string;
  kind: 'stage' | 'route' | 'route-step';
  status?: JourneyMapStage['status'];
  routeId?: string;
  action?: React.ReactNode;
};

type JourneyFlowNode = Node<JourneyFlowNodeData>;

const elk = new ELK();

const LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '58',
  'elk.spacing.nodeNode': '34',
  'elk.padding': '[top=30,left=30,bottom=30,right=30]',
};

function nodeDimensions(node: JourneyFlowNode) {
  if (node.data.kind === 'route') return { width: 290, height: 132 };
  if (node.data.kind === 'route-step') return { width: 250, height: 68 };
  return { width: 230, height: 76 };
}

async function layoutNodes(nodes: JourneyFlowNode[], edges: Edge[]) {
  const graph = {
    id: 'journey',
    layoutOptions: LAYOUT_OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      ...nodeDimensions(node),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layouted = await elk.layout(graph);
  return nodes.map((node) => {
    const position = layouted.children?.find((item) => item.id === node.id);
    return {
      ...node,
      position: {
        x: position?.x ?? 0,
        y: position?.y ?? 0,
      },
    };
  });
}

function stageNode(stage: JourneyMapStage): JourneyFlowNode {
  return {
    id: `stage:${stage.id}`,
    position: { x: 0, y: 0 },
    draggable: false,
    selectable: false,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: {
      kind: 'stage',
      status: stage.status,
      title: stage.title,
      subtitle: stage.status === 'current' ? stage.objective : undefined,
    },
    style: {
      width: 230,
      minHeight: 76,
    },
    className: `journey-flow-node journey-flow-node-stage journey-flow-node-${stage.status}`,
  };
}

function makeRouteGraph(
  journey: JourneyMapProps['journey'],
  routes: JourneyMapRoute[],
  onChooseRoute?: JourneyMapProps['onChooseRoute'],
): { nodes: JourneyFlowNode[]; edges: Edge[] } {
  const stages = journey?.stages ?? [];
  const nodes: JourneyFlowNode[] = stages.map(stageNode);
  const edges: Edge[] = [];

  for (let index = 0; index < stages.length - 1; index += 1) {
    const current = stages[index];
    const next = stages[index + 1];
    const traversed = next.status === 'completed' || next.status === 'current';

    edges.push({
      id: `stage-edge:${current.id}:${next.id}`,
      source: `stage:${current.id}`,
      target: `stage:${next.id}`,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      className: traversed ? 'journey-flow-edge journey-flow-edge-traversed' : 'journey-flow-edge',
    });
  }

  if (!stages.length && routes.length) {
    nodes.push({
      id: 'stage:current',
      position: { x: 0, y: 0 },
      draggable: false,
      selectable: false,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        kind: 'stage',
        status: 'current',
        title: '当前调查',
        subtitle: '没有固定 Workflow，路线由当前目标、证据和用户动作决定。',
      },
      style: { width: 230, minHeight: 76 },
      className: 'journey-flow-node journey-flow-node-stage journey-flow-node-current',
    });
  }

  const anchorStage =
    stages.find((stage) => stage.status === 'current') ??
    [...stages].reverse().find((stage) => stage.status === 'completed') ??
    stages[0];

  const anchorId = anchorStage ? `stage:${anchorStage.id}` : 'stage:current';

  routes.slice(0, 3).forEach((route, routeIndex) => {
    const routeNodeId = `route:${route.id}`;

    nodes.push({
      id: routeNodeId,
      position: { x: 0, y: 0 },
      draggable: false,
      selectable: false,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        kind: 'route',
        title: route.title,
        subtitle: route.reason,
        routeId: route.id,
        action: onChooseRoute ? (
          <Button
            type="link"
            size="small"
            className="journey-flow-route-action nodrag"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onChooseRoute(route)}
          >
            采用这条路线
          </Button>
        ) : undefined,
      },
      style: { width: 290, minHeight: 132 },
      className: 'journey-flow-node journey-flow-node-route',
    });

    edges.push({
      id: `route-anchor:${route.id}`,
      source: anchorId,
      target: routeNodeId,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      className: 'journey-flow-edge journey-flow-edge-suggested',
    });

    route.steps.slice(0, 6).forEach((step, index) => {
      const stepId = `route-step:${route.id}:${index}`;
      const previousId = index === 0 ? routeNodeId : `route-step:${route.id}:${index - 1}`;

      nodes.push({
        id: stepId,
        position: { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          kind: 'route-step',
          title: step,
          subtitle: `路线 ${routeIndex + 1} · 第 ${index + 1} 步`,
        },
        style: { width: 250, minHeight: 68 },
        className: 'journey-flow-node journey-flow-node-route-step',
      });

      edges.push({
        id: `route-edge:${route.id}:${index}`,
        source: previousId,
        target: stepId,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed },
        className: 'journey-flow-edge journey-flow-edge-suggested',
      });
    });
  });

  return { nodes, edges };
}

function JourneyNode({ data }: NodeProps) {
  const nodeData = data as JourneyFlowNodeData;

  return (
    <>
      <Handle type="target" position={Position.Top} className="journey-flow-handle" />
      <div className="journey-flow-node-content">
        <div className="journey-flow-node-title">{nodeData.title}</div>
        {nodeData.subtitle ? <div className="journey-flow-node-subtitle">{nodeData.subtitle}</div> : null}
        {nodeData.kind === 'route' ? (
          <div className="journey-flow-route-meta">
            <Tag bordered={false}>Agent 建议</Tag>
            {nodeData.action}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="journey-flow-handle" />
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
}: JourneyMapProps) {
  const graph = useMemo(
    () => makeRouteGraph(journey, routes, onChooseRoute),
    [journey, routes, onChooseRoute],
  );
  const [nodes, setNodes] = useState<JourneyFlowNode[]>(graph.nodes);
  const [layouting, setLayouting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNodes(graph.nodes);

    if (!graph.nodes.length) return;

    setLayouting(true);
    void layoutNodes(graph.nodes, graph.edges)
      .then((next) => {
        if (!cancelled) setNodes(next);
      })
      .finally(() => {
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

  return (
    <div className="journey-map-canvas">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const nodeData = node.data as JourneyFlowNodeData;
            if (nodeData.kind === 'route') return '#1677ff';
            if (nodeData.status === 'completed') return '#52c41a';
            if (nodeData.status === 'current') return '#1677ff';
            return '#d9d9d9';
          }}
        />
        <Controls showInteractive={false} />
        <Panel position="top-left" className="journey-map-legend">
          <Flex gap={8} wrap>
            <Text type="secondary">实线：已走路线</Text>
            <Text type="secondary">虚线：Agent 建议</Text>
            {layouting ? <Tag bordered={false}>正在整理布局…</Tag> : null}
          </Flex>
        </Panel>
      </ReactFlow>
    </div>
  );
}
