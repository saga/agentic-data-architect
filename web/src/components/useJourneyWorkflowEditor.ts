import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { App as AntApp, Modal } from 'antd';
import {
  addEdge,
  MarkerType,
  Position,
  reconnectEdge,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type ReactFlowInstance,
} from '@xyflow/react';

import {
  definitionFromGraph,
  graphFromDefinition,
  layoutFromNodes,
  nextId,
  nextOutcome,
  normalizeConnection,
  sourceHandleId,
  targetHandleId,
} from './journey-map-graph.js';
import { autoLayoutJourney } from './journey-map-layout.js';
import {
  EDGE_TYPE,
} from './journey-map-types.js';
import type {
  FlowEdge,
  FlowNode,
  JourneyMapStage,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeType,
  CompletionMode,
  WorkflowSnapshot,
} from './journey-map-types.js';

/** 从 URL 取得当前 Investigation 名称。页面路由本身就是唯一上下文来源。 */
function sessionNameFromUrl(): string | undefined {
  const match = window.location.pathname.match(/^\/investigations\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

interface JourneyWorkflowEditorResult {
  snapshot?: WorkflowSnapshot;
  fetching: boolean;
  editing: boolean;
  usingDraft: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNode?: FlowNode;
  selectedEdge?: FlowEdge;
  nodeDraft?: Partial<WorkflowNodeDefinition>;
  edgeDraft?: { outcome: string; target: string };
  connectTargetId?: string;
  connectOutcome: string;
  validationIssues: string[];
  currentDefinition?: WorkflowDefinition;
  currentStage?: JourneyMapStage;
  completedCount: number;
  enterEdit: () => void;
  cancelEdit: () => Promise<void>;
  saveDraft: () => Promise<void>;
  validate: () => Promise<string[]>;
  applyWorkflow: () => Promise<void>;
  resetWorkflow: () => void;
  autoLayout: () => Promise<void>;
  createStandaloneNode: () => Promise<void>;
  addNodeAfter: (sourceId: string, branch: boolean) => Promise<void>;
  deleteNode: (id: string) => void;
  applyNodeDraft: () => Promise<void>;
  applyEdgeDraft: () => Promise<void>;
  connectSelectedNode: () => Promise<void>;
  setNodeDraft: Dispatch<SetStateAction<Partial<WorkflowNodeDefinition> | undefined>>;
  setEdgeDraft: Dispatch<SetStateAction<{ outcome: string; target: string } | undefined>>;
  setConnectTargetId: Dispatch<SetStateAction<string | undefined>>;
  setConnectOutcome: Dispatch<SetStateAction<string>>;
  handleNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  handleEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (connection: Connection) => Promise<void>;
  onReconnect: (oldEdge: FlowEdge, connection: Connection) => Promise<void>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  flowInstanceRef: MutableRefObject<ReactFlowInstance<FlowNode, FlowEdge> | null>;
  onNodeClick: (id: string) => void;
  onEdgeClick: (id: string) => void;
  clearSelection: () => void;
  deleteSelectedEdge: () => void;
  beginNodeDrag: () => void;
}

export function useJourneyWorkflowEditor(): JourneyWorkflowEditorResult {
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
  // ---- 编辑器状态 ---------------------------------------------------------
  // nodes / edges 是 React Flow 的运行时草稿；保存时再转换回 Workflow Definition。
  const [past, setPast] = useState<Array<{ nodes: FlowNode[]; edges: FlowEdge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: FlowNode[]; edges: FlowEdge[] }>>([]);

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState<FlowEdge>([]);
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const snapshotRef = useRef<WorkflowSnapshot | undefined>(undefined);
  const newNodeIdsRef = useRef<Set<string>>(new Set());
  const flowInstanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const lastMeasuredNodeCountRef = useRef(0);
  const layoutRequestRef = useRef(0);

  // React Flow 会在首次渲染和新增节点后重新测量真实 DOM 尺寸。
  // 自动布局必须在“测量完成”后再跑一次，否则 ELK 只能使用估算高度。
  const nodesInitialized = useNodesInitialized({ includeHiddenNodes: true });

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    snapshotRef.current = snapshot;
  }, [nodes, edges, snapshot]);

  /**
   * 所有布局请求共享一个递增 token。
   *
   * ELK 是异步的：用户连续点击“自动排版”、新增节点后又马上修改节点，
   * 老请求可能比新请求更晚返回。没有 token 时，老结果会覆盖新结果。
   * 因此只有最后一次 layout request 可以写回 React Flow。
   */
  const layoutWithLatest = async (
    nodesToLayout: FlowNode[],
    edgesToLayout: FlowEdge[],
  ): Promise<FlowNode[] | undefined> => {
    const requestId = ++layoutRequestRef.current;
    const layouted = await autoLayoutJourney(nodesToLayout, edgesToLayout);

    return requestId === layoutRequestRef.current ? layouted : undefined;
  };



  // ---- 服务端 Workflow 生命周期 -----------------------------------------
  /** 只负责把服务端快照取回来。
   *
   * 画布统一由下面那个 graphKey effect 重建——它知道当前该画"草稿"还是"已应用版本"。
   * 这里千万别顺手建图：带 await fetch 的这条总会后跑完，把草稿覆盖成已应用版本，
   * 结果就是顶部提示"已载入草稿"、校验面板列出问题，画布却还是旧的那张图。
   */
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
          return;
        }
        throw new Error(await response.text());
      }

      setSnapshot(await response.json() as WorkflowSnapshot);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFetching(false);
    }
  }, [message]);

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
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);
    await loadWorkflow();
  };

  // ---- Graph 编辑动作 ----------------------------------------------------
  /**
   * 在一个现有步骤后添加“下一步”或“分支步骤”。
   * 结构变更完成后统一重新走 ELK，保证节点位置与 Handle 数量同步。
   */
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
    const laidOutNodes = await layoutWithLatest(graph.nodes, graph.edges);

    if (!laidOutNodes) return;
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
        setNodes((await layoutWithLatest(graph.nodes, graph.edges)) ?? nodesRef.current);
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

    const layoutedNodes = await layoutWithLatest(graph.nodes, graph.edges);
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

  const handleNodesChange = (changes: NodeChange<FlowNode>[]) => {
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

    void rebuildStructuralGraph(nextNodes, nextEdges, nextNewIds);
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
  };

  const handleEdgesChange = (changes: EdgeChange<FlowEdge>[]) => {
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
    setNodes(await autoLayoutJourney(graph.nodes, graph.edges));
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
    const outcome = connectOutcome.trim() || 'success';
    if (currentEdges.some(
      (edge) =>
        edge.source === source
        && edge.target === target
        && String(edge.data?.outcome ?? '').trim().toLowerCase() === outcome.toLowerCase(),
    )) {
      message.info('相同的 outcome 已经连接到这个目标；可以换一个 outcome。');
      return;
    }

    pushHistory();
    const sourceNode = currentNodes.find((node) => node.id === source);
    const targetNode = currentNodes.find((node) => node.id === target);
    if (!sourceNode || !targetNode) return;

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
    const currentEdges = edgesRef.current;
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

    setNodes(await autoLayoutJourney(graph.nodes, graph.edges));
    setEdges(graph.edges);
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);
  };

  /**
   * 拖动一个节点是一个完整编辑动作，而不是几十/几百次 mousemove。
   * 因此只在 drag start 保存一次 Undo snapshot。
   */
  const beginNodeDrag = () => {
    if (editing) pushHistory();
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
    const laidOutNodes = await autoLayoutJourney(graph.nodes, graph.edges);
    if (!laidOutNodes) return;
    setNodes(laidOutNodes);
    setValidationIssues([]);

    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ padding: 0.18, minZoom: 0.45, maxZoom: 1.1 });
    });
  };

  /** 画布的唯一重建入口：锁定模式画已应用版本，编辑模式优先画草稿。
   *
   * graphKey 决定"什么时候该重画"——来源（已应用 / 草稿）、版本、编辑模式，
   * 再加一份内容签名，因为"恢复内置"不一定改版本号。
   * 保存草稿不会改 key，所以画布不会重建，撤销栈、选中状态和当前视角都留得住。
   */
  const graphKey = (() => {
    if (!snapshot) return 'none';
    const useDraft = editing && usingDraft && Boolean(snapshot.draft);
    const source = useDraft && snapshot.draft ? snapshot.draft.definition : snapshot.definition;
    return [
      snapshot.source,
      String(snapshot.version),
      editing ? 'edit' : 'lock',
      useDraft ? 'draft' : 'active',
      source.nodes.map((node) => node.id + ':' + String(node.routes.length)).join('|'),
    ].join('#');
  })();

  useEffect(() => {
    // 每次真正切换 active/draft/edit 状态时，都允许 React Flow 的实测尺寸
    // 触发一次最终自动排版；否则相同节点数量的 Workflow 切换后不会重新计算。
    lastMeasuredNodeCountRef.current = 0;

    // 依赖里只放 graphKey：snapshot 对象换了但内容没换（保存草稿）时不该重画。
    const current = snapshotRef.current;
    if (!current) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const useDraft = editing && usingDraft && Boolean(current.draft);
    const sourceDefinition = useDraft && current.draft
      ? current.draft.definition
      : current.definition;
    const sourceLayout = useDraft && current.draft
      ? current.draft.layout
      : current.layout;

    let cancelled = false;

    const initializeGraph = async () => {
      const graph = graphFromDefinition(
        sourceDefinition,
        sourceLayout,
        current,
        editing,
        setSelectedNodeId,
        (id) => { void addNodeAfter(id, false); },
        (id) => { void addNodeAfter(id, true); },
        deleteNode,
        setSelectedEdgeId,
        newNodeIdsRef.current,
      );

      const layoutedNodes = sourceLayout.engine === 'elk-v2'
        ? graph.nodes
        : await autoLayoutJourney(graph.nodes, graph.edges);

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
  }, [graphKey]);

  /**
   * 用 React Flow 实际测量的节点尺寸做一次最终布局。
   *
   * 这一步解决了一个很隐蔽的问题：自定义节点在编辑模式和锁定模式的内容高度
   * 并不完全等于固定值。ELK 如果只拿估算尺寸排版，视觉上仍可能出现“节点贴住”
   * 的情况。React Flow 官方提供 useNodesInitialized 来判断尺寸测量是否完成。
   */
  useEffect(() => {
    if (!editing || !nodesInitialized || !nodes.length) return;

    if (lastMeasuredNodeCountRef.current === nodes.length) return;
    lastMeasuredNodeCountRef.current = nodes.length;

    let cancelled = false;

    const relayoutAfterMeasure = async () => {
      const layouted = await layoutWithLatest(nodesRef.current, edgesRef.current);
      if (!cancelled) {
        setNodes(layouted);
      }
    };

    void relayoutAfterMeasure();

    return () => {
      cancelled = true;
    };
  }, [editing, nodesInitialized, nodes.length]);

  const definitionPayload = currentDefinition;
  const layoutPayload = layoutFromNodes(nodes);

  // ---- Draft / Validate / Apply -----------------------------------------
  /**
   * 所有发送给服务端的 definition/layout 都来自当前 React Flow graph，
   * 浏览器端的 validation 只做体验优化，最终规则仍以服务端结果为准。
   */
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
        await loadWorkflow();
      },
    });
  };


  // 把所有编辑动作集中在 hook 内，JourneyMap 只负责布局 UI。
  const activeDefinition = editing && usingDraft && snapshot?.draft
    ? snapshot.draft.definition
    : snapshot?.definition;

  const currentStage = snapshot
    ? snapshot.state.stages.find((stage) => stage.id === snapshot.state.currentNodeId)
      ?? snapshot.state.stages.find((stage) => stage.status === 'current')
      ?? snapshot.state.stages.find((stage) => stage.status === 'future')
      ?? snapshot.state.stages.at(-1)
    : undefined;

  const completedCount = snapshot && activeDefinition
    ? snapshot.state.completedNodeIds.filter((id) =>
        activeDefinition.nodes.some((node) => node.id === id),
      ).length
    : 0;

  return {
    snapshot,
    fetching,
    editing,
    usingDraft,
    nodes,
    edges,
    selectedNode,
    selectedEdge,
    nodeDraft,
    edgeDraft,
    connectTargetId,
    connectOutcome,
    validationIssues,
    currentDefinition: activeDefinition,
    currentStage,
    completedCount,
    enterEdit,
    cancelEdit,
    saveDraft,
    validate,
    applyWorkflow,
    resetWorkflow,
    autoLayout,
    createStandaloneNode,
    addNodeAfter,
    deleteNode,
    applyNodeDraft,
    applyEdgeDraft,
    connectSelectedNode,
    setNodeDraft,
    setEdgeDraft,
    setConnectTargetId,
    setConnectOutcome,
    handleNodesChange,
    handleEdgesChange,
    onConnect,
    onReconnect,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    flowInstanceRef,
    onNodeClick: (id) => setSelectedNodeId(id),
    onEdgeClick: (id) => setSelectedEdgeId(id),
    clearSelection: () => {
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
    },
    deleteSelectedEdge: () => {
      const edgeId = selectedEdgeId;
      if (!edgeId) return;

      pushHistory();
      void rebuildStructuralGraph(
        nodesRef.current,
        edgesRef.current.filter((edge) => edge.id !== edgeId),
      );
      setSelectedEdgeId(undefined);
    },
    beginNodeDrag,
  };
}
