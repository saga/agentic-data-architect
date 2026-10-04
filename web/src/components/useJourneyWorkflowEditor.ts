import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { App as AntApp, Modal } from 'antd';

import {
  applyWorkflowChanges,
  definitionFromGraph,
  graphFromDefinition,
  layoutFromNodes,
  nextId,
  nextOutcome,
  normalizeConnection,
  sourceHandleId,
  targetHandleId,
  type GraphConnection,
} from './journey-map-graph.js';
import { autoLayoutJourney } from './journey-map-layout.js';
import type {
  FlowEdge,
  FlowNode,
  JourneyMapStage,
  WorkflowChange,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeType,
  WorkflowActor,
  CompletionMode,
  WorkflowSnapshot,
} from './journey-map-types.js';
import { JOURNEY_NODE_SIZE } from './journey-map-types.js';

/** 从 URL 取得当前 Investigation 名称。页面路由本身就是唯一上下文来源。 */
function sessionNameFromUrl(): string | undefined {
  const match = window.location.pathname.match(/^\/investigations\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

interface JourneyWorkflowEditorResult {
  snapshot?: WorkflowSnapshot;
  fetching: boolean;
  dirty: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNode?: FlowNode;
  selectedEdge?: FlowEdge;
  nodeDraft?: Partial<WorkflowNodeDefinition>;
  edgeDraft?: { outcome: string; target: string; condition?: string };
  connectTargetId?: string;
  connectOutcome: string;
  validationIssues: string[];
  currentDefinition?: WorkflowDefinition;
  currentStage?: JourneyMapStage;
  completedCount: number;
  fitViewRequest: number;
  saveWorkflow: () => Promise<void>;
  aiEditFlow: (
    prompt: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => Promise<{ message: string; changes: WorkflowChange[] } | undefined>;
  pendingAiChange?: { message: string; changes: WorkflowChange[] };
  applyAiChanges: () => Promise<void>;
  discardAiChanges: () => void;
  applyHumanWorkflowTransition: (outcome: string) => Promise<void>;
  resetWorkflow: () => void;
  autoLayout: () => Promise<void>;
  createStandaloneNode: () => Promise<void>;
  addNodeAfter: (sourceId: string, branch: boolean) => Promise<void>;
  deleteNode: (id: string) => void;
  applyNodeDraft: () => Promise<void>;
  applyEdgeDraft: () => Promise<void>;
  connectSelectedNode: () => Promise<void>;
  setNodeDraft: Dispatch<SetStateAction<Partial<WorkflowNodeDefinition> | undefined>>;
  setEdgeDraft: Dispatch<SetStateAction<{ outcome: string; target: string; condition?: string } | undefined>>;
  setConnectTargetId: Dispatch<SetStateAction<string | undefined>>;
  setConnectOutcome: Dispatch<SetStateAction<string>>;
  onGraphConnect: (connection: GraphConnection) => Promise<void>;
  onGraphReconnect: (edgeId: string, connection: GraphConnection) => Promise<void>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onNodeClick: (id: string) => void;
  onEdgeClick: (id: string) => void;
  clearSelection: () => void;
  deleteSelectedEdge: () => void;
  beginNodeDrag: () => void;
  onNodeMoved: (id: string, position: { x: number; y: number }) => void;
  deleteSelectedCell: (id: string, kind: 'node' | 'edge') => void;
}

export function useJourneyWorkflowEditor(): JourneyWorkflowEditorResult {
  const { message } = AntApp.useApp();

  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>();
  const [fetching, setFetching] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [pendingAiChange, setPendingAiChange] = useState<{
    message: string;
    changes: WorkflowChange[];
    definition: WorkflowDefinition;
    baseDefinition: WorkflowDefinition;
  }>();
  const [nodeDraft, setNodeDraft] = useState<Partial<WorkflowNodeDefinition>>();
  const [edgeDraft, setEdgeDraft] = useState<{ outcome: string; target: string; condition?: string }>();
  const [connectTargetId, setConnectTargetId] = useState<string>();
  const [connectOutcome, setConnectOutcome] = useState('success');
  // 只在打开地图、自动排版或结构变化后请求一次全图适配，拖动节点时不自动缩放。
  const [fitViewRequest, setFitViewRequest] = useState(0);

  // Workflow 运行时草稿完全与图引擎解耦。
  const [past, setPast] = useState<Array<{ nodes: FlowNode[]; edges: FlowEdge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: FlowNode[]; edges: FlowEdge[] }>>([]);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);

  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<FlowEdge[]>([]);
  const snapshotRef = useRef<WorkflowSnapshot | undefined>(undefined);
  const newNodeIdsRef = useRef<Set<string>>(new Set());
  const layoutRequestRef = useRef(0);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    snapshotRef.current = snapshot;
  }, [nodes, edges, snapshot]);

  /**
   * 自动排版可能产生异步结果。多个请求同时发起时，只允许最后一次结果落地。
   * 这一层只保护布局计算，不属于 X6 Graph。
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
      setDirty(false);
      setValidationIssues([]);
      newNodeIdsRef.current = new Set();
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
    return definitionFromGraph(nodes, edges, snapshot.definition);
  }, [snapshot, nodes, edges]);

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
      actor: selectedNode.data.actor,
      completeWhen: selectedNode.data.completeWhen,
      requires: selectedNode.data.requires,
      produces: selectedNode.data.produces,
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
      condition: selectedEdge.data?.condition,
    });
  }, [selectedEdge]);

  const snapshotNow = (): { nodes: FlowNode[]; edges: FlowEdge[] } => ({
    nodes: nodesRef.current.map((node) => ({
      ...node,
      position: { ...node.position },
      data: { ...node.data },
    })),
    edges: edgesRef.current.map((edge) => ({
      ...edge,
      data: edge.data ? { ...edge.data } : { outcome: 'success' },
    })),
  });

  const pushHistory = () => {
    setPast((items) => [...items.slice(-30), snapshotNow()]);
    setFuture([]);
    setDirty(true);
  };

  const rebuildStructuralGraph = async (
    nextNodes: FlowNode[],
    nextEdges: FlowEdge[],
    nextNewIds = new Set(newNodeIdsRef.current),
  ): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] } | undefined> => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) return undefined;

    const definition = definitionFromGraph(
      nextNodes,
      nextEdges,
      currentSnapshot.definition,
    );
    const graph = graphFromDefinition(
      definition,
      layoutFromNodes(nextNodes),
      currentSnapshot,
      (value) => { void addNodeAfter(value, false); },
      (value) => { void addNodeAfter(value, true); },
      deleteNode,
      setSelectedEdgeId,
      nextNewIds,
    );

    const layoutedNodes = await layoutWithLatest(graph.nodes, graph.edges);
    if (!layoutedNodes) return undefined;

    setNodes(layoutedNodes);
    setEdges(graph.edges);
    setFitViewRequest((value) => value + 1);
    setValidationIssues([]);

    return { nodes: layoutedNodes, edges: graph.edges };
  };

  // ---- Graph 编辑动作 ----------------------------------------------------
  /**
   * 在一个现有步骤后添加“下一步”或“分支步骤”。
   * 结构变化之后统一走 Workflow -> graph -> ELK，保证节点和连接同步。
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
      (edge) =>
        edge.source === sourceId
        && String(edge.data?.outcome ?? '').toLowerCase() === 'success',
    );
    const oldSingle = currentEdges.filter((edge) => edge.source === sourceId);

    const node: FlowNode = {
      id,
      type: 'journey',
      position: {
        x: source.position.x + 360,
        y: source.position.y + (branch ? 180 : 0),
      },
      width: JOURNEY_NODE_SIZE.regular.width,
      height: JOURNEY_NODE_SIZE.regular.height,
      data: {
        title: branch ? '新的分支步骤' : '新的下一步',
        objective: '填写这一步要解决的问题。',
        nodeType: 'task',
        status: 'future',
        completion: 'agent',
        actor: 'agent',
        visible: true,
        isNew: true,
        sourceHandles: [{ id: sourceHandleId(id, 0), label: 'success' }],
        targetHandles: [{ id: targetHandleId(id, 0), label: '入口' }],
        onAddStep: (value) => { void addNodeAfter(value, false); },
        onAddBranch: (value) => { void addNodeAfter(value, true); },
        onDelete: (value) => deleteNode(value),
      },
    };

    let nextNodes = [...currentNodes, node];
    let nextEdges = [...currentEdges];

    if (!branch && oldSuccess) {
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
            targetHandle: targetHandleId(oldSuccess.target, 0),
            data: { outcome: oldSuccess.data?.outcome ?? 'success' },
          },
        ]);
    } else if (!branch && oldSingle.length === 1) {
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
            targetHandle: targetHandleId(old.target, 0),
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
          sourceHandle: sourceHandleId(
            sourceId,
            currentEdges.filter((edge) => edge.source === sourceId).length,
          ),
          targetHandle: targetHandleId(id, 0),
          data: { outcome },
        },
      ];

      if (branch && oldSuccess) {
        nextEdges.push({
          id: id + ':success:' + oldSuccess.target,
          source: id,
          target: oldSuccess.target,
          sourceHandle: sourceHandleId(id, 0),
          targetHandle: targetHandleId(oldSuccess.target, 0),
          data: { outcome: 'success' },
        });
      }
    }

    pushHistory();

    const nextNewIds = new Set(newNodeIdsRef.current);
    nextNewIds.add(id);
    newNodeIdsRef.current = nextNewIds;

    const semanticBase = currentSnapshot.definition;
    const definition = definitionFromGraph(nextNodes, nextEdges, semanticBase);
    const graph = graphFromDefinition(
      definition,
      layoutFromNodes(nextNodes),
      currentSnapshot,
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
    setFitViewRequest((value) => value + 1);
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);
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

        await rebuildStructuralGraph(nextNodes, nextEdges, nextNewIds);
        setSelectedNodeId(undefined);
        setSelectedEdgeId(undefined);
      },
    });
  };

  const onGraphConnect = async (connection: GraphConnection) => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const edge = normalizeConnection(connection, currentNodes, currentEdges);
    if (!edge) return;

    pushHistory();
    const rebuilt = await rebuildStructuralGraph(
      [...currentNodes],
      [...currentEdges, edge],
    );

    setSelectedEdgeId(
      rebuilt?.edges.find(
        (item) => item.source === edge.source
          && item.target === edge.target
          && item.data?.outcome === edge.data?.outcome,
      )?.id,
    );
  };

  const onGraphReconnect = async (
    edgeId: string,
    connection: GraphConnection,
  ) => {
    const oldEdge = edgesRef.current.find((edge) => edge.id === edgeId);
    if (!oldEdge) return;
    if (!connection.source || !connection.target || connection.source === connection.target) return;

    pushHistory();

    const nextEdges = edgesRef.current.map((edge) => (
      edge.id === edgeId
        ? {
            ...edge,
            source: connection.source,
            target: connection.target,
            sourceHandle: sourceHandleId(
              connection.source,
              edgesRef.current.filter((candidate) => candidate.source === connection.source).length,
            ),
            targetHandle: targetHandleId(connection.target, 0),
            data: { ...edge.data },
          }
        : edge
    ));

    const rebuilt = await rebuildStructuralGraph(
      nodesRef.current,
      nextEdges,
    );

    setSelectedEdgeId(
      rebuilt?.edges.find(
        (item) => item.source === connection.source
          && item.target === connection.target
          && item.data?.outcome === oldEdge.data?.outcome,
      )?.id,
    );
  };

  const onNodeMoved = (id: string, position: { x: number; y: number }) => {
    setNodes((current) => current.map((node) => (
      node.id === id
        ? { ...node, position: { x: position.x, y: position.y } }
        : node
    )));
    setDirty(true);
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
              actor: (nodeDraft.actor as WorkflowActor) || node.data.actor,
              completeWhen: nodeDraft.completeWhen
                ? String(nodeDraft.completeWhen).trim()
                : undefined,
              requires: nodeDraft.requires,
              produces: nodeDraft.produces,
            },
          }
        : node
    ));

    await rebuildStructuralGraph(nextNodes, currentEdges);
  };

  const applyEdgeDraft = async () => {
    if (!selectedEdge || !edgeDraft) return;

    const outcome = edgeDraft.outcome.trim();
    if (!outcome) {
      message.warning('分支结果不能是空的。');
      return;
    }

    pushHistory();

    const nextEdges = edgesRef.current.map((edge) => (
      edge.id === selectedEdge.id
        ? {
            ...edge,
            target: edgeDraft.target,
            targetHandle: targetHandleId(edgeDraft.target, 0),
            data: {
              ...(edge.data ?? { outcome }),
              outcome,
              ...(edgeDraft.condition?.trim()
                ? { condition: edgeDraft.condition.trim() }
                : {}),
            },
          }
        : edge
    ));

    await rebuildStructuralGraph(nodesRef.current, nextEdges);
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

    const edge: FlowEdge = {
      id: source + ':' + outcome + ':' + target + ':' + String(
        currentEdges.filter((item) => item.source === source).length,
      ),
      source,
      target,
      sourceHandle: sourceHandleId(
        source,
        currentEdges.filter((item) => item.source === source).length,
      ),
      targetHandle: targetHandleId(target, 0),
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
      width: 236,
      height: 210,
      data: {
        title: '新建步骤',
        objective: '填写这一步要解决的问题。',
        nodeType: 'task',
        status: 'future',
        completion: 'agent',
        actor: 'agent',
        visible: true,
        isNew: true,
        sourceHandles: [{ id: sourceHandleId(id, 0), label: 'success' }],
        targetHandles: [{ id: targetHandleId(id, 0), label: '入口' }],
        onAddStep: (value) => { void addNodeAfter(value, false); },
        onAddBranch: (value) => { void addNodeAfter(value, true); },
        onDelete: deleteNode,
      },
    };

    pushHistory();

    const nextIds = new Set(newNodeIdsRef.current);
    nextIds.add(id);
    newNodeIdsRef.current = nextIds;

    const definition = definitionFromGraph(
      [...currentNodes, node],
      currentEdges,
      currentSnapshot.definition,
    );

    const graph = graphFromDefinition(
      definition,
      layoutFromNodes([...currentNodes, node]),
      currentSnapshot,
      (value) => { void addNodeAfter(value, false); },
      (value) => { void addNodeAfter(value, true); },
      deleteNode,
      setSelectedEdgeId,
      nextIds,
    );

    const laidOutNodes = await layoutWithLatest(graph.nodes, graph.edges);
    if (!laidOutNodes) return;

    setNodes(laidOutNodes);
    setEdges(graph.edges);
    setFitViewRequest((value) => value + 1);
    setSelectedNodeId(id);
    setSelectedEdgeId(undefined);
    setValidationIssues([]);
  };

  /** 拖动节点是一个完整编辑动作，X6 只在 node:moved 后写入位置。 */
  const beginNodeDrag = () => {
    pushHistory();
  };

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;

    const current = snapshotNow();

    setFuture((items) => [...items, current]);
    setPast((items) => items.slice(0, -1));
    setDirty(true);
    setNodes(previous.nodes);
    setEdges(previous.edges);
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;

    const current = snapshotNow();

    setPast((items) => [...items, current]);
    setFuture((items) => items.slice(0, -1));
    setDirty(true);
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
      (id) => { void addNodeAfter(id, false); },
      (id) => { void addNodeAfter(id, true); },
      deleteNode,
      setSelectedEdgeId,
      newNodeIdsRef.current,
    );

    const laidOutNodes = await layoutWithLatest(graph.nodes, graph.edges);
    if (!laidOutNodes) return;

    setNodes(laidOutNodes);
    setEdges(graph.edges);
    setFitViewRequest((value) => value + 1);
    setValidationIssues([]);
  };

  /** 服务端定义签名改变时重建画布；普通节点拖动不会改变这里的 signature。 */
  const graphKey = (() => {
    if (!snapshot) return 'none';

    const source = snapshot.definition;
    const signature = source.nodes
      .map((node) => JSON.stringify({
        id: node.id,
        type: node.type,
        title: node.title,
        objective: node.objective,
        visible: node.visible,
        completion: node.completion,
        actor: node.actor,
        completeWhen: node.completeWhen,
        routes: node.routes.map(({ outcome, target, condition }) => ({
          outcome,
          target,
          condition,
        })),
      }))
      .sort()
      .join('|');

    return [snapshot.source, String(snapshot.version), signature].join('#');
  })();

  useEffect(() => {
    const current = snapshotRef.current;

    if (!current) {
      setNodes([]);
      setEdges([]);
      return;
    }

    let cancelled = false;

    const initializeGraph = async () => {
      const graph = graphFromDefinition(
        current.definition,
        current.layout,
        current,
        (id) => { void addNodeAfter(id, false); },
        (id) => { void addNodeAfter(id, true); },
        deleteNode,
        setSelectedEdgeId,
        newNodeIdsRef.current,
      );

      const shouldAutoLayout =
        current.source !== 'custom' || current.layout.engine !== 'workflow-v1';

      const layoutedNodes = shouldAutoLayout
        ? await autoLayoutJourney(graph.nodes, graph.edges)
        : graph.nodes;

      if (cancelled) return;

      setNodes(layoutedNodes);
      setEdges(graph.edges);
      setFitViewRequest((value) => value + 1);
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
      setPast([]);
      setFuture([]);
      setDirty(false);
    };

    void initializeGraph();

    return () => {
      cancelled = true;
    };
  }, [graphKey]);

  /** 保存当前画布；服务端仍然验证 Workflow Definition。 */
  const saveWorkflow = async () => {
    const name = sessionNameFromUrl();
    if (!name || !currentDefinition) return;

    try {
      const response = await fetch(
        '/api/sessions/' + encodeURIComponent(name) + '/workflow',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            definition: currentDefinition,
            layout: layoutFromNodes(nodes),
          }),
        },
      );

      const body = await response.json() as {
        snapshot?: WorkflowSnapshot;
        issues?: string[];
        error?: string;
      };

      if (!response.ok) {
        const issues = body.issues ?? [];
        setValidationIssues(issues);
        throw new Error(
          issues.length
            ? '工作地图还不能保存，请先修正：' + issues.join('；')
            : body.error || response.statusText,
        );
      }

      if (body.snapshot) setSnapshot(body.snapshot);

      setDirty(false);
      setValidationIssues([]);
      newNodeIdsRef.current = new Set();
      setPast([]);
      setFuture([]);
      message.success('工作地图已保存。');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  /** AI 只提出 Patch；先预览，用户确认后再应用。 */
  const aiEditFlow = async (
    prompt: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ) => {
    const name = sessionNameFromUrl();
    const currentSnapshot = snapshotRef.current;
    if (!name || !prompt.trim() || !currentSnapshot) return undefined;

    const currentCanvasDefinition = definitionFromGraph(
      nodesRef.current,
      edgesRef.current,
      currentSnapshot.definition,
    );

    try {
      const response = await fetch(
        '/api/sessions/' + encodeURIComponent(name) + '/workflow/ai',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: prompt.trim(),
            messages: history.slice(-12),
            definition: currentCanvasDefinition,
            ...(selectedNodeId ? { selectedNodeId } : {}),
          }),
        },
      );

      const body = await response.json() as {
        definition?: WorkflowDefinition;
        message?: string;
        changes?: WorkflowChange[];
        error?: string;
      };

      if (!response.ok || !body.definition || !body.changes?.length) {
        throw new Error(body.error || response.statusText || 'AI 没有返回 Workflow 修改。');
      }

      setPendingAiChange({
        message: body.message?.trim() || 'AI 已提出一版修改。',
        changes: body.changes,
        definition: body.definition,
        baseDefinition: currentCanvasDefinition,
      });

      return {
        message: body.message?.trim() || 'AI 已提出修改，请检查预览。',
        changes: body.changes,
      };
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const applyAiChanges = async () => {
    const pending = pendingAiChange;
    const currentSnapshot = snapshotRef.current;
    if (!pending || !currentSnapshot) return;

    const currentCanvasDefinition = definitionFromGraph(
      nodesRef.current,
      edgesRef.current,
      currentSnapshot.definition,
    );

    if (JSON.stringify(currentCanvasDefinition) !== JSON.stringify(pending.baseDefinition)) {
      message.warning('画布已经发生变化，请重新让 AI 修改当前版本。');
      setPendingAiChange(undefined);
      return;
    }

    try {
      const nextDefinition = applyWorkflowChanges(
        currentCanvasDefinition,
        pending.changes,
      );

      pushHistory();

      const graph = graphFromDefinition(
        nextDefinition,
        layoutFromNodes(nodesRef.current),
        { ...currentSnapshot, definition: nextDefinition },
        (id) => { void addNodeAfter(id, false); },
        (id) => { void addNodeAfter(id, true); },
        deleteNode,
        setSelectedEdgeId,
        new Set(),
      );

      const layoutedNodes = await layoutWithLatest(graph.nodes, graph.edges);
      if (!layoutedNodes) return;

      newNodeIdsRef.current = new Set();
      setNodes(layoutedNodes);
      setEdges(graph.edges);
      setFitViewRequest((value) => value + 1);
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
      setValidationIssues([]);
      setDirty(true);
      setPendingAiChange(undefined);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const discardAiChanges = () => setPendingAiChange(undefined);

  /** 人工完成当前 waiting 节点；服务端负责 version/状态校验。 */
  const applyHumanWorkflowTransition = async (outcome: string) => {
    const name = sessionNameFromUrl();
    const currentSnapshot = snapshotRef.current;
    if (!name || !currentSnapshot) return;

    if (dirty) {
      message.warning('当前画布有未保存修改，请先保存，再推进人工步骤。');
      return;
    }

    try {
      const response = await fetch(
        '/api/sessions/' + encodeURIComponent(name) + '/workflow/transition',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: currentSnapshot.execution.currentNodeId,
            outcome,
          }),
        },
      );

      const body = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || response.statusText || '人工 Workflow transition 失败。');
      }

      await loadWorkflow();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  };

  const resetWorkflow = () => {
    const name = sessionNameFromUrl();
    if (!name) return;

    Modal.confirm({
      title: '恢复内置工作地图？',
      content: '当前自定义工作地图会被删除，改回这个工作方式自带的路线。',
      okText: '恢复',
      cancelText: '取消',
      onOk: async () => {
        const response = await fetch(
          '/api/sessions/' + encodeURIComponent(name) + '/workflow/reset',
          { method: 'POST' },
        );

        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) {
          message.error(body.error || '恢复工作地图失败，请重试。');
          return;
        }

        message.success('已恢复内置工作地图。');
        await loadWorkflow();
      },
    });
  };

  const deleteSelectedCell = (id: string, kind: 'node' | 'edge') => {
    if (kind === 'edge') {
      if (!edgesRef.current.some((edge) => edge.id === id)) return;

      pushHistory();

      void rebuildStructuralGraph(
        nodesRef.current,
        edgesRef.current.filter((edge) => edge.id !== id),
      );

      setSelectedEdgeId(undefined);
      return;
    }

    deleteNode(id);
  };

  const deleteSelectedEdge = () => {
    const edgeId = selectedEdgeId;
    if (!edgeId) return;
    deleteSelectedCell(edgeId, 'edge');
  };

  // ---- 当前步骤 / 输出 ---------------------------------------------------
  const activeDefinition = snapshot?.definition;

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
    dirty,
    nodes,
    edges,
    selectedNode,
    selectedEdge,
    nodeDraft,
    edgeDraft,
    connectTargetId,
    connectOutcome,
    validationIssues,
    currentDefinition,
    pendingAiChange: pendingAiChange
      ? {
          message: pendingAiChange.message,
          changes: pendingAiChange.changes,
        }
      : undefined,
    currentStage,
    completedCount,
    fitViewRequest,
    saveWorkflow,
    aiEditFlow,
    applyAiChanges,
    discardAiChanges,
    applyHumanWorkflowTransition,
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
    onGraphConnect,
    onGraphReconnect,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    onNodeClick: (id) => setSelectedNodeId(id),
    onEdgeClick: (id) => setSelectedEdgeId(id),
    clearSelection: () => {
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
    },
    deleteSelectedEdge,
    beginNodeDrag,
    onNodeMoved,
    deleteSelectedCell,
  };
}
