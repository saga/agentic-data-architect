import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp,
  Button,
  Empty,
  Flex,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AimOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  LockOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  SettingOutlined,
  UndoOutlined,
  UploadOutlined,
  NodeIndexOutlined,
} from '@ant-design/icons';
import {
  addEdge,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
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

type WorkflowNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';
type CompletionMode = 'deterministic' | 'agent';

interface JourneyRouteDefinition {
  outcome: string;
  target: string;
  line?: number;
}

interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  title: string;
  objective?: string;
  visible: boolean;
  completion: CompletionMode;
  completeWhen?: string;
  tools?: string[];
  routes: JourneyRouteDefinition[];
  line?: number;
}

interface WorkflowDefinition {
  id: string;
  start: string;
  nodes: WorkflowNodeDefinition[];
}

interface WorkflowLayout {
  version: 1;
  nodes: Record<string, { x: number; y: number }>;
  /** 画布布局算法；旧数据没有此字段时，编辑器会自动升级到 ELK 布局。 */
  engine?: 'elk';
  viewport?: { x: number; y: number; zoom: number };
}

interface WorkflowExecution {
  workflowId: string;
  workflowVersion: number;
  currentNodeId: string;
  completedNodeIds: string[];
  status: 'active' | 'completed' | 'stopped';
}

interface WorkflowState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: JourneyMapStage[];
  execution: WorkflowExecution;
}

interface WorkflowSnapshot {
  workflowId: string;
  source: 'base' | 'custom';
  baseWorkflowId: string;
  version: number;
  definition: WorkflowDefinition;
  layout: WorkflowLayout;
  execution: WorkflowExecution;
  state: WorkflowState;
  draft: {
    definition: WorkflowDefinition;
    layout: WorkflowLayout;
    issues: string[];
  } | null;
}

interface JourneyMapProps {
  journey?: { stages: JourneyMapStage[] };
  routes?: JourneyMapRoute[];
  loading?: boolean;
  onChooseRoute?: (route: JourneyMapRoute) => void;
  onAskStage?: (stage: JourneyMapStage) => void;
}

interface FlowNodeData extends Record<string, unknown> {
  title: string;
  objective?: string;
  nodeType: WorkflowNodeType;
  status: JourneyMapStage['status'];
  completion: CompletionMode;
  completeWhen?: string;
  visible: boolean;
  editing: boolean;
  isNew?: boolean;
  sourceHandles: Array<{ id: string; label: string }>;
  targetHandles: Array<{ id: string; label: string }>;
  onSelect?: (id: string) => void;
  onAddStep?: (id: string) => void;
  onAddBranch?: (id: string) => void;
  onDelete?: (id: string) => void;
}

interface FlowEdgeData extends Record<string, unknown> {
  outcome: string;
  labelOffsetY?: number;
  onSelect?: (id: string) => void;
}

type FlowNode = Node<FlowNodeData>;
type FlowEdge = Edge<FlowEdgeData>;

const NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  task: '任务',
  gate: '判断点',
  review: '评审',
  end: '完成',
  stop: '停止',
};

const STATUS_META: Record<JourneyMapStage['status'], { label: string; icon: React.ReactNode }> = {
  completed: { label: '已完成', icon: <CheckCircleFilled /> },
  current: { label: '当前', icon: <AimOutlined /> },
  future: { label: '待进入', icon: <ClockCircleOutlined /> },
  locked: { label: '暂不可走', icon: <LockOutlined /> },
};

const STATUS_CLASS: Record<JourneyMapStage['status'], string> = {
  completed: 'journey-flow-node-completed',
  current: 'journey-flow-node-current',
  future: 'journey-flow-node-future',
  locked: 'journey-flow-node-locked',
};

const EDGE_TYPE = 'journey';

function sessionNameFromUrl(): string | undefined {
  const match = window.location.pathname.match(/^\/investigations\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

const elk = new ELK();

function sourceHandleId(nodeId: string, index: number): string {
  return nodeId + '-out-' + String(index);
}

function targetHandleId(nodeId: string, index: number): string {
  return nodeId + '-in-' + String(index);
}

interface HandleSpec {
  id: string;
  label: string;
}

function handleStyle(index: number, total: number): React.CSSProperties {
  const top = ((index + 1) / (total + 1)) * 100;
  // React Flow 自己负责 Left/Right handle 的水平偏移和垂直居中；
  // 这里只改变 top，否则覆盖它的 transform 会让连线起点错位。
  return { top: String(top) + '%' };
}

function stageStatus(snapshot: WorkflowSnapshot, id: string): JourneyMapStage['status'] {
  if (snapshot.state.completedNodeIds.includes(id)) return 'completed';
  if (snapshot.state.currentNodeId === id) return 'current';
  if (snapshot.state.unlockedNodeIds.includes(id)) return 'future';
  return 'locked';
}

function graphFromDefinition(
  definition: WorkflowDefinition,
  layout: WorkflowLayout,
  snapshot: WorkflowSnapshot,
  editing: boolean,
  onSelectNode?: (id: string) => void,
  onAddStep?: (id: string) => void,
  onAddBranch?: (id: string) => void,
  onDelete?: (id: string) => void,
  onSelectEdge?: (id: string) => void,
  newNodeIds: Set<string> = new Set(),
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const incoming = new Map<string, Array<{ source: string; outcome: string; id: string }>>();
  const outgoing = new Map<string, Array<{ target: string; outcome: string; id: string }>>();

  for (const node of definition.nodes) {
    node.routes.forEach((route, index) => {
      const id = node.id + ':' + route.outcome + ':' + route.target + ':' + String(index);
      outgoing.set(node.id, [
        ...(outgoing.get(node.id) ?? []),
        { target: route.target, outcome: route.outcome, id },
      ]);
      incoming.set(route.target, [
        ...(incoming.get(route.target) ?? []),
        { source: node.id, outcome: route.outcome, id },
      ]);
    });
  }

  const nodes: FlowNode[] = definition.nodes.map((item) => {
    const status = stageStatus(snapshot, item.id);
    const position = layout.nodes[item.id] ?? { x: 0, y: 0 };
    const sourceHandles: HandleSpec[] = (outgoing.get(item.id) ?? []).map((route, index) => ({
      id: sourceHandleId(item.id, index),
      label: route.outcome,
    }));
    const targetHandles: HandleSpec[] = (incoming.get(item.id) ?? []).map((route, index) => ({
      id: targetHandleId(item.id, index),
      label: route.outcome,
    }));

    // A node with no incoming/outgoing route still needs one usable handle in edit mode.
    if (!sourceHandles.length && item.type !== 'end' && item.type !== 'stop') {
      sourceHandles.push({ id: sourceHandleId(item.id, 0), label: '新分支' });
    }
    if (!targetHandles.length) {
      targetHandles.push({ id: targetHandleId(item.id, 0), label: '入口' });
    }

    return {
      id: item.id,
      type: 'journey',
      position,
      draggable: editing,
      selectable: editing,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        title: item.title,
        objective: item.objective,
        nodeType: item.type,
        status,
        completion: item.completion,
        completeWhen: item.completeWhen,
        visible: item.visible,
        editing,
        isNew: newNodeIds.has(item.id),
        sourceHandles,
        targetHandles,
        onSelect: onSelectNode,
        onAddStep,
        onAddBranch,
        onDelete,
      },
      hidden: !editing && !item.visible,
      className:
        'journey-flow-node journey-flow-node-stage '
        + STATUS_CLASS[status]
        + (newNodeIds.has(item.id) ? ' journey-flow-node-new' : ''),
      style: {
        width: item.type === 'end' || item.type === 'stop' ? 178 : 236,
      },
    };
  });

  const visibleIds = new Set(
    nodes.filter((node) => !node.hidden).map((node) => node.id),
  );
  const edges: FlowEdge[] = [];

  for (const node of definition.nodes) {
    for (const [index, route] of node.routes.entries()) {
      if (!editing && (!visibleIds.has(node.id) || !visibleIds.has(route.target))) continue;

      const sourceCompleted = snapshot.state.completedNodeIds.includes(node.id);
      const isCurrent = snapshot.state.currentNodeId === node.id;
      const targetIncoming = incoming.get(route.target) ?? [];
      const incomingIndex = targetIncoming.findIndex(
        (edge) => edge.id === node.id + ':' + route.outcome + ':' + route.target + ':' + String(index),
      );

      edges.push({
        id: node.id + ':' + route.outcome + ':' + route.target + ':' + String(index),
        source: node.id,
        target: route.target,
        sourceHandle: sourceHandleId(node.id, index),
        targetHandle: targetHandleId(route.target, Math.max(0, incomingIndex)),
        type: EDGE_TYPE,
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: isCurrent,
        className:
          'journey-flow-edge'
          + (sourceCompleted ? ' journey-flow-edge-traversed' : ''),
        data: {
          outcome: route.outcome,
          labelOffsetY:
            (index - (node.routes.length - 1) / 2) * 18
            + (Math.max(0, incomingIndex) - (Math.max(0, targetIncoming.length) - 1) / 2) * 8,
          onSelect: onSelectEdge,
        },
      });
    }
  }

  return { nodes, edges };
}

/**
 * ELK 的 layered 布局比固定 x/y 更适合当前 Workflow：
 * - 按流程方向从左到右分层
 * - 计算节点间距
 * - 配合明确的 source/target ports 减少边交叉
 * - ORTHOGONAL routing 让分支更容易绕开节点
 */
async function layoutWithElk(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Promise<FlowNode[]> {
  // ELK 的 TS 类型没有把全部 JSON 扩展属性暴露出来，但这些 properties
  // 正是官方 React Flow multiple-handles 示例用于声明 port side / order 的字段。
  const graph = {
    id: 'journey-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.layered.spacing.edgeNodeBetweenLayers': '45',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '30',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: Number(node.style?.width ?? 236),
      height: node.data.nodeType === 'end' || node.data.nodeType === 'stop' ? 90 : 128,
      ports: [
        ...node.data.targetHandles.map((handle) => ({
          id: handle.id,
          properties: { side: 'WEST' },
        })),
        ...node.data.sourceHandles.map((handle) => ({
          id: handle.id,
          properties: { side: 'EAST' },
        })),
      ],
      properties: {
        'org.eclipse.elk.portConstraints': 'FIXED_ORDER',
      },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.sourceHandle ?? edge.source],
      targets: [edge.targetHandle ?? edge.target],
    })),
  } as unknown as Parameters<typeof elk.layout>[0];

  const result = await elk.layout(graph);
  const layouted = result.children ?? [];

  const positions = new Map(layouted.map((node) => [node.id, {
    x: node.x ?? 0,
    y: node.y ?? 0,
  }]));

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }));
}


function JourneyFlowNode({ id, data, selected }: NodeProps<FlowNode>) {
  const meta = STATUS_META[data.status];
  const terminal = data.nodeType === 'end' || data.nodeType === 'stop';
  const targetHandles = data.targetHandles;
  const sourceHandles = data.sourceHandles;

  return (
    <>
      {targetHandles.map((handle, index) => (
        <Handle
          type="target"
          position={Position.Left}
          id={handle.id}
          className={data.editing ? 'journey-flow-handle journey-flow-handle-edit' : 'journey-flow-handle'}
          style={handleStyle(index, targetHandles.length)}
          key={handle.id}
        />
      ))}

      {data.editing ? (
        <NodeToolbar isVisible={selected} position={Position.Top} offset={10} className="journey-node-editor-toolbar">
          <Space size={4}>
            <Tooltip title="编辑节点属性">
              <Button size="small" icon={<EditOutlined />} onClick={() => data.onSelect?.(id)} />
            </Tooltip>
            {!terminal ? (
              <>
                <Tooltip title="在当前成功出口后插入一步">
                  <Button size="small" icon={<PlusOutlined />} onClick={() => data.onAddStep?.(id)} />
                </Tooltip>
                <Tooltip title="添加一条独立分支">
                  <Button size="small" icon={<BranchesOutlined />} onClick={() => data.onAddBranch?.(id)} />
                </Tooltip>
              </>
            ) : null}
            <Tooltip title="删除节点">
              <Button danger size="small" icon={<DeleteOutlined />} onClick={() => data.onDelete?.(id)} />
            </Tooltip>
          </Space>
        </NodeToolbar>
      ) : null}

      <div className="journey-flow-node-content journey-flow-stage-content">
        <div className={'journey-flow-node-kicker journey-flow-node-kicker-' + data.status}>
          {meta.icon}
          <span>{meta.label}</span>
          <span className="journey-flow-node-type">{NODE_TYPE_LABEL[data.nodeType]}</span>
        </div>
        <div className="journey-flow-node-title">{data.title}</div>
        <div className="journey-flow-node-subtitle">
          {data.objective || '未设置步骤目标'}
        </div>

        {data.isNew ? (
          <Tag color="warning" className="journey-flow-node-new-tag">
            新建步骤
          </Tag>
        ) : null}

        {data.editing ? (
          <div className="journey-flow-node-config">
            <Tag bordered={false}>
              {data.completion === 'deterministic' ? '确定性完成' : 'Agent 判断'}
            </Tag>
            {data.completeWhen ? (
              <Text type="secondary">条件：{data.completeWhen}</Text>
            ) : null}
            <Text type="secondary" className="journey-flow-connect-hint">
              右侧圆点拖到其他步骤左侧圆点即可连接
            </Text>
          </div>
        ) : null}
      </div>

      {!terminal ? (
        sourceHandles.map((handle, index) => (
          <Handle
            type="source"
            position={Position.Right}
            id={handle.id}
            className={data.editing ? 'journey-flow-handle journey-flow-handle-edit' : 'journey-flow-handle'}
            style={handleStyle(index, sourceHandles.length)}
            key={handle.id}
          />
        ))
      ) : null}
    </>
  );
}

function JourneyFlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={{ type: MarkerType.ArrowClosed }} />
      <EdgeLabelRenderer>
        <div
          className="journey-flow-edge-label nodrag nopan"
          style={{
            transform:
              'translate(-50%, -50%) translate('
              + labelX
              + 'px,'
              + (labelY + Number(data?.labelOffsetY ?? 0))
              + 'px)',
            pointerEvents: 'all',
          }}
          onClick={() => data?.onSelect?.(id)}
        >
          {data?.outcome}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { journey: JourneyFlowNode };
const edgeTypes = { journey: JourneyFlowEdge };

function nextId(prefix: string, existing: Set<string>): string {
  let index = existing.size + 1;
  let id = prefix + '-' + index;
  while (existing.has(id)) {
    index += 1;
    id = prefix + '-' + index;
  }
  return id;
}

function nextOutcome(routes: JourneyRouteDefinition[], base: string): string {
  const used = new Set(routes.map((route) => route.outcome.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let index = 1;
  while (used.has(base.toLowerCase() + '-' + String(index))) index += 1;
  return base + '-' + String(index);
}

function layoutFromNodes(nodes: FlowNode[]): WorkflowLayout {
  const result: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    result[node.id] = { x: node.position.x, y: node.position.y };
  }
  return { version: 1, engine: 'elk', nodes: result };
}

function definitionFromGraph(nodes: FlowNode[], edges: FlowEdge[], base: WorkflowDefinition): WorkflowDefinition {
  const routeBySource = new Map<string, JourneyRouteDefinition[]>();

  for (const edge of edges) {
    const routes = routeBySource.get(edge.source) ?? [];
    routes.push({
      outcome: edge.data?.outcome || 'success',
      target: edge.target,
    });
    routeBySource.set(edge.source, routes);
  }

  return {
    ...base,
    nodes: nodes.map((node) => {
      const source = base.nodes.find((item) => item.id === node.id);
      return {
        id: node.id,
        type: node.data.nodeType,
        title: node.data.title,
        objective: node.data.objective,
        visible: node.data.visible,
        completion: node.data.completion,
        completeWhen: node.data.completeWhen,
        tools: source?.tools,
        routes: routeBySource.get(node.id) ?? [],
        line: source?.line,
      };
    }),
  };
}

function normalizeConnection(
  connection: Connection,
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowEdge | null {
  if (!connection.source || !connection.target || connection.source === connection.target) return null;

  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode) return null;

  const outgoing = edges.filter((edge) => edge.source === connection.source);
  const incoming = edges.filter((edge) => edge.target === connection.target);
  const outcome = nextOutcome(
    outgoing.map((edge) => ({
      outcome: edge.data?.outcome || 'branch',
      target: edge.target,
    })),
    'branch',
  );

  // 直接按“新增后的索引”生成 port id；下一次 rebuild 会按新的边集合渲染这些 handles。
  // 不复用最后一个 handle，否则多个分支会重新叠到同一个连接点。
  const sourceHandle = sourceHandleId(connection.source, outgoing.length);
  const targetHandle = targetHandleId(connection.target, incoming.length);

  return {
    id: connection.source + ':' + outcome + ':' + connection.target + ':' + String(outgoing.length),
    source: connection.source,
    target: connection.target,
    sourceHandle,
    targetHandle,
    type: EDGE_TYPE,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: {
      outcome,
      labelOffsetY: (outgoing.length - Math.floor(outgoing.length / 2)) * 8,
    },
  };
}

export function JourneyMap({
  journey,
  routes = [],
  loading = false,
  onChooseRoute,
  onAskStage,
}: JourneyMapProps) {
  const { message } = AntApp.useApp();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>();
  const [fetching, setFetching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [usingDraft, setUsingDraft] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [nodeDraft, setNodeDraft] = useState<Partial<WorkflowNodeDefinition>>();
  const [edgeDraft, setEdgeDraft] = useState<{ outcome: string; target: string }>();
  const [connectTargetId, setConnectTargetId] = useState<string>();
  const [connectOutcome, setConnectOutcome] = useState('success');
  const [past, setPast] = useState<Array<{ nodes: FlowNode[]; edges: FlowEdge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: FlowNode[]; edges: FlowEdge[] }>>([]);
  const [newNodeIds, setNewNodeIds] = useState<Set<string>>(new Set());

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState<FlowEdge>([]);
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const snapshotRef = useRef<WorkflowSnapshot>();
  const newNodeIdsRef = useRef<Set<string>>(new Set());
  const flowInstanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    snapshotRef.current = snapshot;
  }, [nodes, edges, snapshot]);

  const loadWorkflow = useCallback(async () => {
    const name = sessionNameFromUrl();
    if (!name) return;

    setFetching(true);

    try {
      const response = await fetch(
        '/api/sessions/' + encodeURIComponent(name) + '/workflow',
      );

      if (!response.ok) {
        if (response.status === 409) {
          setSnapshot(undefined);
          setNodes([]);
          setEdges([]);
          return;
        }
        throw new Error(await response.text());
      }

      const data = await response.json() as WorkflowSnapshot;
      setSnapshot(data);

      if (!editing) {
        const graph = graphFromDefinition(
          data.definition,
          data.layout,
          data,
          false,
          setSelectedNodeId,
          undefined,
          undefined,
          undefined,
          setSelectedEdgeId,
        );

        const shouldUpgradeLayout = data.layout.engine !== 'elk';
        const laidOutNodes = shouldUpgradeLayout
          ? await layoutWithElk(graph.nodes, graph.edges)
          : graph.nodes;

        setNodes(laidOutNodes);
        setEdges(graph.edges);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFetching(false);
    }
  }, [editing, message, setEdges, setNodes]);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

  const currentDefinition = useMemo(() => {
    if (!snapshot) return undefined;
    const base = editing && usingDraft && snapshot.draft
      ? snapshot.draft.definition
      : snapshot.definition;
    return definitionFromGraph(nodes, edges, base);
  }, [snapshot, editing, usingDraft, nodes, edges]);

  const selectedNode = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  const selectedEdge = selectedEdgeId
    ? edges.find((edge) => edge.id === selectedEdgeId)
    : undefined;

  useEffect(() => {
    if (!selectedNode) {
      setNodeDraft(undefined);
      return;
    }
    setNodeDraft({
      id: selectedNode.id,
      type: selectedNode.data.nodeType,
      title: selectedNode.data.title,
      objective: selectedNode.data.objective,
      visible: selectedNode.data.visible,
      completion: selectedNode.data.completion,
      completeWhen: selectedNode.data.completeWhen,
    });
  }, [selectedNode]);

  useEffect(() => {
    if (!selectedEdge) {
      setEdgeDraft(undefined);
      return;
    }
    setEdgeDraft({
      outcome: selectedEdge.data?.outcome || 'success',
      target: selectedEdge.target,
    });
  }, [selectedEdge]);

  const snapshotNow = (): { nodes: FlowNode[]; edges: FlowEdge[] } => ({
    nodes: nodesRef.current.map((node) => ({
      ...node,
      data: { ...node.data },
      position: { ...node.position },
    })),
    edges: edgesRef.current.map((edge) => ({
      ...edge,
      data: edge.data ? { ...edge.data } : undefined,
    })),
  });

  const pushHistory = () => {
    setPast((items) => [...items.slice(-30), snapshotNow()]);
    setFuture([]);
  };

  const enterEdit = () => {
    if (!snapshot) return;
    setUsingDraft(Boolean(snapshot.draft));
    setEditing(true);
    setValidationIssues(snapshot.draft?.issues ?? []);
  };

  const cancelEdit = async () => {
    setEditing(false);
    setUsingDraft(false);
    newNodeIdsRef.current = new Set();
    setNewNodeIds(new Set());
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);
    await loadWorkflow();
  };

  const addNodeAfter = async (sourceId: string, branch: boolean) => {
    const currentSnapshot = snapshotRef.current;
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    if (!currentSnapshot) return;

    const source = currentNodes.find((node) => node.id === sourceId);
    if (!source) return;

    const id = nextId('step', new Set(currentNodes.map((node) => node.id)));
    const oldSuccess = currentEdges.find(
      (edge) => edge.source === sourceId
        && String(edge.data?.outcome ?? '').toLowerCase() === 'success',
    );
    const oldSingle = currentEdges.length
      ? currentEdges.filter((edge) => edge.source === sourceId)
      : [];

    const node: FlowNode = {
      id,
      type: 'journey',
      position: {
        x: source.position.x + 360,
        y: source.position.y + (branch ? 190 : 0),
      },
      draggable: true,
      selectable: true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        title: branch ? '新的分支步骤' : '新的下一步',
        objective: '填写这一步要解决的问题。',
        nodeType: 'task',
        status: 'future',
        completion: 'agent',
        visible: true,
        editing: true,
        isNew: true,
        sourceHandles: [{ id: sourceHandleId(id, 0), label: 'success' }],
        targetHandles: [{ id: targetHandleId(id, 0), label: '入口' }],
        onSelect: setSelectedNodeId,
        onAddStep: (value) => { void addNodeAfter(value, false); },
        onAddBranch: (value) => { void addNodeAfter(value, true); },
        onDelete: (value) => deleteNode(value),
      },
      className: 'journey-flow-node journey-flow-node-stage journey-flow-node-future journey-flow-node-new',
      style: { width: 236 },
    };

    let nextNodes = [...currentNodes, node];
    let nextEdges = [...currentEdges];

    if (!branch && oldSuccess) {
      // “添加下一步”不是再造一条 success-1，而是把新节点插到现有 success 路线上。
      nextEdges = nextEdges
        .filter((edge) => edge.id !== oldSuccess.id)
        .concat([
          {
            ...oldSuccess,
            target: id,
            targetHandle: targetHandleId(id, 0),
            id: oldSuccess.id + ':insert:' + id,
          },
          {
            id: id + ':success:' + oldSuccess.target,
            source: id,
            target: oldSuccess.target,
            sourceHandle: sourceHandleId(id, 0),
            targetHandle: oldSuccess.targetHandle,
            type: EDGE_TYPE,
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { outcome: oldSuccess.data?.outcome ?? 'success' },
          },
        ]);
    } else if (!branch && oldSingle.length === 1) {
      // 只有一条非 success 出口时，也按“插入一步”处理，保留原 outcome。
      const old = oldSingle[0];
      nextEdges = nextEdges
        .filter((edge) => edge.id !== old.id)
        .concat([
          {
            ...old,
            target: id,
            targetHandle: targetHandleId(id, 0),
            id: old.id + ':insert:' + id,
          },
          {
            id: id + ':pass:' + old.target,
            source: id,
            target: old.target,
            sourceHandle: sourceHandleId(id, 0),
            targetHandle: old.targetHandle,
            type: EDGE_TYPE,
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { outcome: 'success' },
          },
        ]);
    } else {
      const outcome = nextOutcome(
        currentEdges
          .filter((edge) => edge.source === sourceId)
          .map((edge) => ({
            outcome: edge.data?.outcome || 'branch',
            target: edge.target,
          })),
        branch ? 'branch' : 'success',
      );

      nextEdges = [
        ...nextEdges,
        {
          id: sourceId + ':' + outcome + ':' + id,
          source: sourceId,
          target: id,
          type: EDGE_TYPE,
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { outcome },
        },
      ];

      // 如果原节点已经有明确的主 success 目标，新的分支先接回该目标。
      // 用户之后可以在边属性中改 outcome/target，而不是面对一个悬空节点。
      if (branch && oldSuccess) {
        nextEdges.push({
          id: id + ':success:' + oldSuccess.target,
          source: id,
          target: oldSuccess.target,
          type: EDGE_TYPE,
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { outcome: 'success' },
        });
      }
    }

    pushHistory();
    const nextNewIds = new Set(newNodeIdsRef.current);
    nextNewIds.add(id);
    newNodeIdsRef.current = nextNewIds;
    setNewNodeIds(nextNewIds);

    const semanticBase = currentSnapshot.draft?.definition ?? currentSnapshot.definition;
    const definition = definitionFromGraph(nextNodes, nextEdges, semanticBase);
    const graph = graphFromDefinition(
      definition,
      layoutFromNodes(nextNodes),
      currentSnapshot,
      true,
      setSelectedNodeId,
      (value) => { void addNodeAfter(value, false); },
      (value) => { void addNodeAfter(value, true); },
      deleteNode,
      setSelectedEdgeId,
      nextNewIds,
    );
    const laidOutNodes = await layoutWithElk(graph.nodes, graph.edges);

    setNodes(laidOutNodes);
    setEdges(graph.edges);
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);

    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ padding: 0.18, minZoom: 0.45, maxZoom: 1.1 });
    });
  };

  const deleteNode = (id: string) => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) return;

    if (id === currentSnapshot.definition.start) {
      message.warning('不能删除当前 Workflow 的第一步。可以修改它，或把它重新连接到其他步骤。');
      return;
    }

    Modal.confirm({
      title: '删除这个步骤？',
      content: '与这个步骤相连的分支也会一并删除；应用前可以继续撤销。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        const currentNodes = nodesRef.current;
        const currentEdges = edgesRef.current;
        pushHistory();

        const nextNodes = currentNodes.filter((node) => node.id !== id);
        const nextEdges = currentEdges.filter(
          (edge) => edge.source !== id && edge.target !== id,
        );

        const nextNewIds = new Set(newNodeIdsRef.current);
        nextNewIds.delete(id);
        newNodeIdsRef.current = nextNewIds;
        setNewNodeIds(nextNewIds);

        const base = currentSnapshot.draft?.definition ?? currentSnapshot.definition;
        const definition = definitionFromGraph(nextNodes, nextEdges, base);
        const graph = graphFromDefinition(
          definition,
          layoutFromNodes(nextNodes),
          currentSnapshot,
          true,
          setSelectedNodeId,
          (value) => { void addNodeAfter(value, false); },
          (value) => { void addNodeAfter(value, true); },
          deleteNode,
          setSelectedEdgeId,
          nextNewIds,
        );
        setNodes(await layoutWithElk(graph.nodes, graph.edges));
        setEdges(graph.edges);
        setSelectedNodeId(undefined);
        setSelectedEdgeId(undefined);
        setValidationIssues([]);
      },
    });
  };

  const rebuildStructuralGraph = async (
    nextNodes: FlowNode[],
    nextEdges: FlowEdge[],
    nextNewIds = new Set(newNodeIdsRef.current),
  ): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] } | undefined> => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) return undefined;

    const base = currentSnapshot.draft?.definition ?? currentSnapshot.definition;
    const definition = definitionFromGraph(nextNodes, nextEdges, base);
    const graph = graphFromDefinition(
      definition,
      layoutFromNodes(nextNodes),
      currentSnapshot,
      true,
      setSelectedNodeId,
      (value) => { void addNodeAfter(value, false); },
      (value) => { void addNodeAfter(value, true); },
      deleteNode,
      setSelectedEdgeId,
      nextNewIds,
    );

    const layoutedNodes = await layoutWithElk(graph.nodes, graph.edges);
    setNodes(layoutedNodes);
    setEdges(graph.edges);
    setValidationIssues([]);
    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ padding: 0.18, minZoom: 0.45, maxZoom: 1.1 });
    });
    return { nodes: layoutedNodes, edges: graph.edges };
  };

  const onConnect = async (connection: Connection) => {
    if (!editing) return;

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const edge = normalizeConnection(connection, currentNodes, currentEdges);
    if (!edge) return;

    pushHistory();
    const rebuilt = await rebuildStructuralGraph(
      [...currentNodes],
      addEdge(edge, currentEdges),
    );
    setSelectedEdgeId(
      rebuilt?.edges.find(
        (item) =>
          item.source === edge.source
          && item.target === edge.target
          && item.data?.outcome === edge.data?.outcome,
      )?.id,
    );
  };

  const onReconnect = async (oldEdge: FlowEdge, connection: Connection) => {
    if (!editing || !connection.source || !connection.target || connection.source === connection.target) return;

    pushHistory();
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const remainingEdges = currentEdges.filter((edge) => edge.id !== oldEdge.id);
    const nextConnection = {
      ...connection,
      sourceHandle: sourceHandleId(
        connection.source,
        remainingEdges.filter((edge) => edge.source === connection.source).length,
      ),
      targetHandle: targetHandleId(
        connection.target,
        remainingEdges.filter((edge) => edge.target === connection.target).length,
      ),
    };
    const rebuilt = await rebuildStructuralGraph(
      [...currentNodes],
      reconnectEdge(oldEdge, nextConnection, currentEdges),
    );
    setSelectedEdgeId(
      rebuilt?.edges.find(
        (item) =>
          item.source === connection.source
          && item.target === connection.target
          && item.data?.outcome === oldEdge.data?.outcome,
      )?.id,
    );
  };

  const handleNodesChange = (
    changes: Parameters<typeof onNodesChangeInternal>[0],
  ) => {
    const removed = changes.filter((change) => change.type === 'remove');
    if (!editing || !removed.length) {
      onNodesChangeInternal(changes);
      return;
    }

    pushHistory();
    const removedIds = new Set(removed.map((change) => change.id));
    const nextNodes = nodesRef.current.filter((node) => !removedIds.has(node.id));
    const nextEdges = edgesRef.current.filter(
      (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
    );

    for (const id of removedIds) {
      if (id === snapshotRef.current?.definition.start) {
        message.warning('不能删除 Workflow 的第一步。');
        return;
      }
    }

    const nextNewIds = new Set(newNodeIdsRef.current);
    for (const id of removedIds) nextNewIds.delete(id);
    newNodeIdsRef.current = nextNewIds;
    setNewNodeIds(nextNewIds);

    void rebuildStructuralGraph(nextNodes, nextEdges, nextNewIds);
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
  };

  const handleEdgesChange = (
    changes: Parameters<typeof onEdgesChangeInternal>[0],
  ) => {
    const removed = changes.filter((change) => change.type === 'remove');
    if (!editing || !removed.length) {
      onEdgesChangeInternal(changes);
      return;
    }

    pushHistory();
    const removedIds = new Set(removed.map((change) => change.id));
    const nextEdges = edgesRef.current.filter((edge) => !removedIds.has(edge.id));
    void rebuildStructuralGraph(nodesRef.current, nextEdges);
    setSelectedEdgeId(undefined);
  };

  const applyNodeDraft = async () => {
    if (!selectedNode || !nodeDraft) return;

    pushHistory();
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const nextNodes = currentNodes.map((node) => (
      node.id === selectedNode.id
        ? {
            ...node,
            data: {
              ...node.data,
              title: String(nodeDraft.title || node.data.title),
              objective: nodeDraft.objective ? String(nodeDraft.objective) : undefined,
              nodeType: (nodeDraft.type as WorkflowNodeType) || node.data.nodeType,
              visible: nodeDraft.visible !== false,
              completion: (nodeDraft.completion as CompletionMode) || node.data.completion,
              completeWhen: nodeDraft.completeWhen
                ? String(nodeDraft.completeWhen).trim()
                : undefined,
            },
          }
        : node
    ));

    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) return;
    const base = currentSnapshot.draft?.definition ?? currentSnapshot.definition;
    const definition = definitionFromGraph(nextNodes, currentEdges, base);
    const graph = graphFromDefinition(
      definition,
      layoutFromNodes(nextNodes),
      currentSnapshot,
      true,
      setSelectedNodeId,
      (id) => { void addNodeAfter(id, false); },
      (id) => { void addNodeAfter(id, true); },
      deleteNode,
      setSelectedEdgeId,
      newNodeIdsRef.current,
    );
    setNodes(await layoutWithElk(graph.nodes, graph.edges));
    setEdges(graph.edges);
    setValidationIssues([]);
  };

  const applyEdgeDraft = async () => {
    if (!selectedEdge || !edgeDraft) return;
    const outcome = edgeDraft.outcome.trim();
    if (!outcome) {
      message.warning('分支结果不能是空的。');
      return;
    }

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    if (
      currentEdges.some(
        (edge) =>
          edge.id !== selectedEdge.id
          && edge.source === selectedEdge.source
          && edge.target === edgeDraft.target,
      )
    ) {
      message.info('这个节点已经连向该目标步骤；可以保留一条连接，再通过 outcome 区分。');
    }

    pushHistory();
    const nextEdges = currentEdges.map((edge) => (
      edge.id === selectedEdge.id
        ? {
            ...edge,
            target: edgeDraft.target,
            data: {
              ...(edge.data ?? {}),
              outcome,
            },
          }
        : edge
    ));
    await rebuildStructuralGraph(currentNodes, nextEdges);
  };

  const connectSelectedNode = async () => {
    const source = selectedNodeId;
    const target = connectTargetId;
    if (!source || !target || source === target) {
      message.warning('请选择一个不同于当前节点的目标步骤。');
      return;
    }

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    if (currentEdges.some((edge) => edge.source === source && edge.target === target)) {
      message.info('这两个步骤已经有连接。点击对应连线标签可以修改 outcome。');
      return;
    }

    pushHistory();
    const sourceNode = currentNodes.find((node) => node.id === source);
    const targetNode = currentNodes.find((node) => node.id === target);
    if (!sourceNode || !targetNode) return;

    const outcome = connectOutcome.trim() || 'success';
    const edge: FlowEdge = {
      id: source + ':' + outcome + ':' + target + ':' + String(
        currentEdges.filter((item) => item.source === source).length,
      ),
      source,
      target,
      type: EDGE_TYPE,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { outcome },
    };
    await rebuildStructuralGraph(currentNodes, [...currentEdges, edge]);
    setConnectTargetId(undefined);
    setConnectOutcome('success');
    setSelectedEdgeId(edge.id);
  };

  const createStandaloneNode = async () => {
    const currentSnapshot = snapshotRef.current;
    const currentNodes = nodesRef.current;
    if (!currentSnapshot) return;

    const id = nextId('step', new Set(currentNodes.map((node) => node.id)));
    const maxX = currentNodes.reduce((max, node) => Math.max(max, node.position.x), 0);
    const node: FlowNode = {
      id,
      type: 'journey',
      position: { x: maxX + 360, y: 0 },
      draggable: true,
      selectable: true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        title: '新建步骤',
        objective: '填写这一步要解决的问题。',
        nodeType: 'task',
        status: 'future',
        completion: 'agent',
        visible: true,
        editing: true,
        isNew: true,
        sourceHandles: [{ id: sourceHandleId(id, 0), label: 'success' }],
        targetHandles: [{ id: targetHandleId(id, 0), label: '入口' }],
        onSelect: setSelectedNodeId,
        onAddStep: (value) => { void addNodeAfter(value, false); },
        onAddBranch: (value) => { void addNodeAfter(value, true); },
        onDelete: deleteNode,
      },
      className: 'journey-flow-node journey-flow-node-stage journey-flow-node-future journey-flow-node-new',
      style: { width: 236 },
    };

    pushHistory();
    const nextIds = new Set(newNodeIdsRef.current);
    nextIds.add(id);
    newNodeIdsRef.current = nextIds;
    setNewNodeIds(nextIds);

    const base = currentSnapshot.draft?.definition ?? currentSnapshot.definition;
    const definition = definitionFromGraph([...currentNodes, node], currentEdges, base);
    const graph = graphFromDefinition(
      definition,
      layoutFromNodes([...currentNodes, node]),
      currentSnapshot,
      true,
      setSelectedNodeId,
      (value) => { void addNodeAfter(value, false); },
      (value) => { void addNodeAfter(value, true); },
      deleteNode,
      setSelectedEdgeId,
      nextIds,
    );

    setNodes(await layoutWithElk(graph.nodes, graph.edges));
    setEdges(graph.edges);
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);
  };

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    const current = snapshotNow();
    setFuture((items) => [...items, current]);
    setPast((items) => items.slice(0, -1));
    setNodes(previous.nodes);
    setEdges(previous.edges);
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    const current = snapshotNow();
    setPast((items) => [...items, current]);
    setFuture((items) => items.slice(0, -1));
    setNodes(next.nodes);
    setEdges(next.edges);
  };

  const autoLayout = async () => {
    if (!currentDefinition) return;

    pushHistory();
    const graph = graphFromDefinition(
      currentDefinition,
      layoutFromNodes(nodesRef.current),
      snapshotRef.current ?? snapshot!,
      true,
      setSelectedNodeId,
      (id) => { void addNodeAfter(id, false); },
      (id) => { void addNodeAfter(id, true); },
      deleteNode,
      setSelectedEdgeId,
      newNodeIdsRef.current,
    );
    const laidOutNodes = await layoutWithElk(graph.nodes, graph.edges);
    setNodes(laidOutNodes);
    setValidationIssues([]);

    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ padding: 0.18, minZoom: 0.45, maxZoom: 1.1 });
    });
  };

  useEffect(() => {
    if (!editing || !snapshot) return;

    let cancelled = false;
    const sourceDefinition = usingDraft && snapshot.draft
      ? snapshot.draft.definition
      : snapshot.definition;
    const sourceLayout = usingDraft && snapshot.draft
      ? snapshot.draft.layout
      : snapshot.layout;

    const initializeGraph = async () => {
      const graph = graphFromDefinition(
        sourceDefinition,
        sourceLayout,
        snapshot,
        true,
        setSelectedNodeId,
        (id) => { void addNodeAfter(id, false); },
        (id) => { void addNodeAfter(id, true); },
        deleteNode,
        setSelectedEdgeId,
        newNodeIdsRef.current,
      );

      const layoutedNodes = sourceLayout.engine === 'elk'
        ? graph.nodes
        : await layoutWithElk(graph.nodes, graph.edges);

      if (cancelled) return;

      setNodes(layoutedNodes);
      setEdges(graph.edges);
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
      setPast([]);
      setFuture([]);

      requestAnimationFrame(() => {
        flowInstanceRef.current?.fitView({
          padding: 0.18,
          minZoom: 0.45,
          maxZoom: 1.1,
        });
      });
    };

    void initializeGraph();

    return () => {
      cancelled = true;
    };
  }, [editing, usingDraft, snapshot?.version]);

  const definitionPayload = currentDefinition;
  const layoutPayload = layoutFromNodes(nodes);

  const validate = async (): Promise<string[]> => {
    const name = sessionNameFromUrl();
    if (!name || !definitionPayload) return ['没有当前 Workflow。'];

    const response = await fetch(
      '/api/sessions/' + encodeURIComponent(name) + '/workflow/validate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: definitionPayload, layout: layoutPayload }),
      },
    );
    const body = await response.json() as { issues?: string[]; error?: string };
    if (!response.ok) throw new Error(body.error || response.statusText);
    const issues = body.issues ?? [];
    setValidationIssues(issues);
    return issues;
  };

  const saveDraft = async () => {
    const name = sessionNameFromUrl();
    if (!name || !definitionPayload) return;

    try {
      const response = await fetch(
        '/api/sessions/' + encodeURIComponent(name) + '/workflow/draft',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ definition: definitionPayload, layout: layoutPayload }),
        },
      );
      const body = await response.json() as {
        issues?: string[];
        error?: string;
        snapshot?: WorkflowSnapshot;
      };
      if (!response.ok) throw new Error(body.error || response.statusText);
      setValidationIssues(body.issues ?? []);
      if (body.snapshot) setSnapshot(body.snapshot);
      // 当前画布本身就是刚保存的草稿，不重新装载，避免保存后清空撤销栈和选中状态。
      message.success(body.issues?.length ? '草稿已保存，但还有校验问题。' : 'Workflow 草稿已保存。');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const applyWorkflow = async () => {
    const issues = await validate();
    if (issues.length) {
      message.error('验证未通过，先修正工作地图中的问题。');
      return;
    }

    const name = sessionNameFromUrl();
    if (!name || !definitionPayload) return;

    try {
      const response = await fetch(
        '/api/sessions/' + encodeURIComponent(name) + '/workflow/apply',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ definition: definitionPayload, layout: layoutPayload }),
        },
      );
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || response.statusText);

      message.success('Workflow 已应用；能保留的当前执行位置会继续使用新版本。');
      setEditing(false);
      setUsingDraft(false);
      newNodeIdsRef.current = new Set();
      setNewNodeIds(new Set());
      setValidationIssues([]);
      await loadWorkflow();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const resetWorkflow = () => {
    const name = sessionNameFromUrl();
    if (!name) return;

    Modal.confirm({
      title: '恢复内置 Workflow？',
      content: '当前 Investigation 的自定义 Workflow、草稿、布局和执行位置都会恢复到 Skill 内置版本。',
      okText: '恢复',
      cancelText: '取消',
      onOk: async () => {
        const response = await fetch(
          '/api/sessions/' + encodeURIComponent(name) + '/workflow/reset',
          { method: 'POST' },
        );
        if (!response.ok) {
          message.error(await response.text());
          return;
        }
        message.success('已恢复内置 Workflow。');
        setEditing(false);
        setUsingDraft(false);
        newNodeIdsRef.current = new Set();
        setNewNodeIds(new Set());
        await loadWorkflow();
      },
    });
  };

  if (loading || fetching) {
    return (
      <div className="journey-map-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正在整理工作地图…" />
      </div>
    );
  }

  if (!snapshot) {
    if (!journey?.stages.length && !routes.length) {
      return (
        <div className="journey-map-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前是自主调查，没有固定 Workflow。"
          />
        </div>
      );
    }

    return (
      <div className="journey-map-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="工作地图加载失败。请关闭后重新打开。" />
      </div>
    );
  }

  const activeDefinition = editing && usingDraft && snapshot.draft
    ? snapshot.draft.definition
    : snapshot.definition;
  const currentStage = snapshot.state.stages.find((stage) => stage.id === snapshot.state.currentNodeId)
    ?? snapshot.state.stages.find((stage) => stage.status === 'current')
    ?? snapshot.state.stages.find((stage) => stage.status === 'future')
    ?? snapshot.state.stages.at(-1);
  const completedCount = snapshot.state.completedNodeIds.filter((id) => activeDefinition.nodes.some((node) => node.id === id)).length;

  return (
    <div className={'journey-map-canvas journey-map-editor-shell' + (editing ? ' journey-map-editor-mode' : '')}>
      <div className="journey-map-editor-header">
        <div>
          <div className="journey-map-heading-title">工作地图</div>
          <div className="journey-map-heading-subtitle">
            {editing
              ? '正在编辑 Workflow 草稿。拖动节点、连线、添加分支；验证通过后才会真正改变执行路线。'
              : '这是当前 Workflow 的实际路线。Agent 会在当前节点内工作，完成后只能沿已有出口继续。'}
          </div>
        </div>
        <Flex align="center" gap={8} wrap>
          <Tag color={snapshot.source === 'custom' ? 'blue' : undefined}>
            {snapshot.source === 'custom' ? '自定义 v' + String(snapshot.version) : '内置 Workflow'}
          </Tag>
          {editing ? (
            <>
              <Button size="small" icon={<UndoOutlined />} disabled={!past.length} onClick={undo}>撤销</Button>
              <Button size="small" icon={<RedoOutlined />} disabled={!future.length} onClick={redo}>重做</Button>
              <Button size="small" icon={<NodeIndexOutlined />} onClick={() => void autoLayout()}>
                自动排版
              </Button>
              <Button size="small" icon={<PlusOutlined />} onClick={() => void createStandaloneNode()}>
                新建步骤
              </Button>
              <Button size="small" icon={<SaveOutlined />} onClick={() => void saveDraft()}>保存草稿</Button>
              <Button size="small" onClick={() => void validate()}>验证</Button>
              <Button size="small" onClick={resetWorkflow}>恢复内置</Button>
              <Button size="small" onClick={() => void cancelEdit()}>取消</Button>
              <Button type="primary" size="small" icon={<UploadOutlined />} onClick={() => void applyWorkflow()}>
                应用修改
              </Button>
            </>
          ) : (
            <Button type="primary" ghost size="small" icon={<EditOutlined />} onClick={enterEdit}>
              编辑工作地图
            </Button>
          )}
        </Flex>
      </div>

      {editing && snapshot.draft ? (
        <div className="journey-map-draft-banner">
          <Text>已载入之前保存的草稿。当前执行位置仍属于 active Workflow，直到你点击“应用修改”。</Text>
        </div>
      ) : null}

      {editing && validationIssues.length ? (
        <div className="journey-map-validation-panel">
          <div className="journey-map-validation-title">
            <Text strong>验证问题 {validationIssues.length}</Text>
            <Text type="secondary">这些问题修正后才能应用。</Text>
          </div>
          <div className="journey-map-validation-items">
            {validationIssues.slice(0, 8).map((issue, index) => (
              <Text type="danger" key={index}>• {issue}</Text>
            ))}
            {validationIssues.length > 8 ? <Text type="secondary">还有 {validationIssues.length - 8} 个问题…</Text> : null}
          </div>
        </div>
      ) : null}

      <div className="journey-map-editor-body">
        <div className="journey-map-flow-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
            edgeTypes={edgeTypes}
            nodesDraggable={editing}
            nodesConnectable={editing}
            elementsSelectable={editing}
            edgesReconnectable={editing}
            connectionLineType="smoothstep"
            connectionRadius={28}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodeDragStart={() => {
              if (editing) pushHistory();
            }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onNodeClick={(_, node) => editing && setSelectedNodeId(node.id)}
            onEdgeClick={(_, edge) => editing && setSelectedEdgeId(edge.id)}
            onPaneClick={() => {
              if (!editing) return;
              setSelectedNodeId(undefined);
              setSelectedEdgeId(undefined);
            }}
            fitView
            fitViewOptions={{ padding: 0.18, minZoom: 0.55, maxZoom: 1.2 }}
            colorMode="light"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1} variant={BackgroundVariant.Dots} color="#dfe5ee" />
            <Controls showInteractive={editing} />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(node) => {
                const data = node.data as FlowNodeData;
                if (data.status === 'completed') return '#52c41a';
                if (data.status === 'current') return '#1677ff';
                if (data.status === 'locked') return '#d9d9d9';
                return '#b5c0cf';
              }}
              nodeStrokeWidth={3}
              maskColor="rgba(247,249,252,.76)"
            />
          </ReactFlow>
        </div>

        {editing ? (
          <div className="journey-map-inspector">
            <div className="journey-map-inspector-header">
              <div>
                <div className="journey-map-inspector-title">属性</div>
                <Text type="secondary">
                  {selectedNode ? '节点属性' : selectedEdge ? '分支属性' : '先选一个节点或分支'}
                </Text>
              </div>
              <SettingOutlined />
            </div>

            {selectedNode && nodeDraft ? (
              <Flex vertical gap={12}>
                <div>
                  <Text type="secondary">ID</Text>
                  <Input value={selectedNode.id} disabled />
                </div>
                <div>
                  <Text type="secondary">名称</Text>
                  <Input
                    value={String(nodeDraft.title ?? '')}
                    onChange={(event) => setNodeDraft({ ...nodeDraft, title: event.target.value })}
                  />
                </div>
                <div>
                  <Text type="secondary">目标</Text>
                  <Input.TextArea
                    value={String(nodeDraft.objective ?? '')}
                    onChange={(event) => setNodeDraft({ ...nodeDraft, objective: event.target.value })}
                    autoSize={{ minRows: 2, maxRows: 5 }}
                  />
                </div>
                <div>
                  <Text type="secondary">节点类型</Text>
                  <Select
                    value={nodeDraft.type}
                    style={{ width: '100%' }}
                    options={Object.entries(NODE_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
                    onChange={(value) => setNodeDraft({ ...nodeDraft, type: value as WorkflowNodeType })}
                  />
                </div>
                <div>
                  <Text type="secondary">完成方式</Text>
                  <Select
                    value={nodeDraft.completion}
                    style={{ width: '100%' }}
                    options={[
                      { value: 'agent', label: 'Agent 判断结果' },
                      { value: 'deterministic', label: '确定性条件' },
                    ]}
                    onChange={(value) => setNodeDraft({ ...nodeDraft, completion: value as CompletionMode })}
                  />
                </div>
                {nodeDraft.completion === 'deterministic' ? (
                  <div>
                    <Text type="secondary">completeWhen</Text>
                    <Input
                      value={String(nodeDraft.completeWhen ?? '')}
                      placeholder="例如 goal / current-state / validation"
                      onChange={(event) => setNodeDraft({ ...nodeDraft, completeWhen: event.target.value })}
                    />
                  </div>
                ) : null}
                <div className="journey-map-connect-box">
                  <Text strong>连接到现有步骤</Text>
                  <Text type="secondary">新建步骤通常需要先接回现有流程，否则验证会提示它没有出口。</Text>
                  <Select
                    value={connectTargetId}
                    allowClear
                    placeholder="选择目标步骤"
                    style={{ width: '100%' }}
                    options={nodes
                      .filter((node) => node.id !== selectedNode.id)
                      .map((node) => ({
                        value: node.id,
                        label: node.id + ' · ' + node.data.title,
                      }))}
                    onChange={(value) => setConnectTargetId(value)}
                  />
                  <Input
                    value={connectOutcome}
                    placeholder="success / retry / needs-input"
                    onChange={(event) => setConnectOutcome(event.target.value)}
                    addonBefore="outcome"
                  />
                  <Button
                    block
                    icon={<ArrowRightOutlined />}
                    disabled={!connectTargetId}
                    onClick={() => void connectSelectedNode()}
                  >
                    建立连接
                  </Button>
                  <Text type="secondary" className="journey-map-connect-hint">
                    也可以直接拖动右侧圆点 → 目标步骤左侧圆点。
                  </Text>
                </div>
                                <Button type="primary" icon={<SaveOutlined />} onClick={applyNodeDraft}>应用节点属性</Button>
              </Flex>
            ) : selectedEdge && edgeDraft ? (
              <Flex vertical gap={12}>
                <div>
                  <Text type="secondary">分支结果</Text>
                  <Input
                    value={edgeDraft.outcome}
                    placeholder="success / needs-input / retry"
                    onChange={(event) => setEdgeDraft({ ...edgeDraft, outcome: event.target.value })}
                  />
                </div>
                <div>
                  <Text type="secondary">目标</Text>
                  <Select
                    value={edgeDraft.target}
                    style={{ width: '100%' }}
                    options={nodes.map((node) => ({ value: node.id, label: node.id + ' · ' + node.data.title }))}
                    onChange={(value) => setEdgeDraft({ ...edgeDraft, target: value })}
                  />
                </div>
                <Flex gap={8}>
                  <Button type="primary" icon={<SaveOutlined />} onClick={applyEdgeDraft}>应用分支属性</Button>
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      if (!selectedEdge) return;
                      pushHistory();
                      void rebuildStructuralGraph(
                        nodesRef.current,
                        edgesRef.current.filter((edge) => edge.id !== selectedEdge.id),
                      );
                      setSelectedEdgeId(undefined);
                    }}
                  >
                    删除分支
                  </Button>
                </Flex>
              </Flex>
            ) : (
              <div className="journey-map-inspector-empty">
                <HolderOutlined />
                <Text type="secondary">点击节点编辑属性；点击连线标签修改分支结果或目标。</Text>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {!editing ? (
        <>
          <div className="journey-map-summary-row">
            <Flex gap={8} align="center" wrap>
              <Text strong>{currentStage?.title ?? '当前调查'}</Text>
              <Tag bordered={false}>{completedCount}/{Math.max(activeDefinition.nodes.filter((node) => node.visible).length, 1)} 已完成</Tag>
              <Tag bordered={false}>{snapshot.state.currentNodeId}</Tag>
            </Flex>
            {currentStage && onAskStage ? (
              <Button size="small" type="primary" ghost icon={<ArrowRightOutlined />} onClick={() => onAskStage(currentStage)}>
                围绕当前阶段继续
              </Button>
            ) : null}
          </div>

          {routes.length ? (
            <div className="journey-map-route-list">
              <div className="journey-map-route-list-title">
                <BranchesOutlined /> Agent 临时建议
              </div>
              <Flex gap={8} wrap>
                {routes.slice(0, 3).map((route) => (
                  <Button key={route.id} size="small" onClick={() => onChooseRoute?.(route)}>
                    {route.title}
                  </Button>
                ))}
              </Flex>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
