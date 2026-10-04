import {
  EDGE_TYPE,
  STATUS_CLASS,
  TARGET_HANDLE_ID,
  type FlowEdge,
  type FlowNode,
  type HandleSpec,
  type JourneyMapStage,
  type WorkflowChange,
  type WorkflowDefinition,
  type WorkflowLayout,
  type WorkflowNodeDefinition,
  type WorkflowSnapshot,
} from './journey-map-types.js';

/** 给已有出口生成稳定的 source port ID。 */
export function sourceHandleId(nodeId: string, index: number): string {
  return nodeId + '-out-' + String(index);
}

/** X6 中所有节点共享一个入口 port。多个 edge 可以连接到同一个入口 port。 */
export function targetHandleId(_nodeId: string, _index = 0): string {
  return TARGET_HANDLE_ID;
}

/** 根据真实执行状态给节点映射 UI 状态。 */
export function stageStatus(
  snapshot: WorkflowSnapshot,
  id: string,
): JourneyMapStage['status'] {
  if (snapshot.state.completedNodeIds.includes(id)) return 'completed';
  if (snapshot.state.currentNodeId === id) return 'current';
  if (snapshot.state.unlockedNodeIds.includes(id)) return 'future';
  return 'locked';
}

/** 为 UI 生成稳定的节点 ID。 */
export function nextId(prefix: string, existing: Set<string>): string {
  let index = existing.size + 1;
  let id = prefix + '-' + index;

  while (existing.has(id)) {
    index += 1;
    id = prefix + '-' + index;
  }

  return id;
}

/** 为新增分支生成不重复的 outcome。 */
export function nextOutcome(
  routes: JourneyRouteDefinitionLike[],
  base: string,
): string {
  const used = new Set(routes.map((route) => route.outcome.toLowerCase()));

  if (!used.has(base.toLowerCase())) return base;

  let index = 1;
  while (used.has(base.toLowerCase() + '-' + String(index))) {
    index += 1;
  }

  return base + '-' + String(index);
}

type JourneyRouteDefinitionLike = {
  outcome: string;
  target: string;
};

/**
 * 去掉同一 source 下完全重复的 route。
 * 这是语义层的防御，不依赖 X6 是否把重叠边渲染成一条。
 */
export function dedupeRoutes(
  routes: WorkflowNodeDefinition['routes'],
): WorkflowNodeDefinition['routes'] {
  const seen = new Set<string>();

  return routes.filter((route) => {
    const key =
      route.target
      + '\u0000'
      + route.outcome.trim().toLowerCase()
      + '\u0000'
      + String(route.condition ?? '').trim();

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 浏览器侧应用语义 Patch。
 *
 * React/X6 都只是编辑器适配层；AI 预览真正应用时仍然通过这里回到 Workflow Definition。
 */
export function applyWorkflowChanges(
  definitionInput: WorkflowDefinition,
  changes: WorkflowChange[],
): WorkflowDefinition {
  const definition: WorkflowDefinition = {
    ...definitionInput,
    nodes: definitionInput.nodes.map((node) => ({
      ...node,
      tools: node.tools ? [...node.tools] : undefined,
      requires: node.requires ? [...node.requires] : undefined,
      produces: node.produces ? [...node.produces] : undefined,
      routes: dedupeRoutes(node.routes).map((route) => ({ ...route })),
    })),
  };

  for (const change of changes) {
    switch (change.type) {
      case 'replace-definition':
        return change.definition;
      case 'add-node':
        if (definition.nodes.some((node) => node.id === change.node.id)) {
          throw new Error('不能新增重复节点：' + change.node.id);
        }
        definition.nodes.push({
          ...change.node,
          tools: change.node.tools ? [...change.node.tools] : undefined,
          requires: change.node.requires ? [...change.node.requires] : undefined,
          produces: change.node.produces ? [...change.node.produces] : undefined,
          routes: dedupeRoutes(change.node.routes).map((route) => ({ ...route })),
        });
        break;
      case 'update-node': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到节点：' + change.nodeId);
        Object.assign(node, change.patch);
        break;
      }
      case 'remove-node':
        if (change.nodeId === definition.start) {
          throw new Error('不能删除 Workflow start 节点。');
        }
        definition.nodes = definition.nodes
          .filter((node) => node.id !== change.nodeId)
          .map((node) => ({
            ...node,
            routes: node.routes.filter((route) => route.target !== change.nodeId),
          }));
        break;
      case 'add-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到节点：' + change.nodeId);
        node.routes = dedupeRoutes([
          ...node.routes,
          { ...change.route },
        ]);
        break;
      }
      case 'update-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到节点：' + change.nodeId);
        const route = node.routes.find(
          (item) => item.outcome.toLowerCase() === change.outcome.toLowerCase(),
        );
        if (!route) throw new Error('找不到分支：' + change.nodeId + '/' + change.outcome);
        Object.assign(route, change.patch);
        node.routes = dedupeRoutes(node.routes);
        break;
      }
      case 'remove-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到节点：' + change.nodeId);
        node.routes = node.routes.filter(
          (route) => route.outcome.toLowerCase() !== change.outcome.toLowerCase(),
        );
        break;
      }
    }
  }

  return definition;
}

/** 保存 X6 画布位置；布局数据仍然只保存节点坐标，不保存图引擎内部对象。 */
export function layoutFromNodes(nodes: FlowNode[]): WorkflowLayout {
  const result: Record<string, { x: number; y: number }> = {};

  for (const node of nodes) {
    result[node.id] = {
      x: node.position.x,
      y: node.position.y,
    };
  }

  return {
    version: 1,
    engine: 'elk-v5',
    nodes: result,
  };
}

/**
 * 把当前图还原为 Workflow Definition。
 *
 * X6 的 Node/Edge 对象不进入业务层；这里仍然只读取稳定的 source/target/outcome。
 */
export function definitionFromGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  base: WorkflowDefinition,
): WorkflowDefinition {
  const routeBySource = new Map<string, JourneyRouteDefinitionLike[]>();

  for (const edge of edges) {
    if (edge.source === edge.target) continue;

    const routes = routeBySource.get(edge.source) ?? [];

    routes.push({
      outcome: edge.data?.outcome || 'success',
      target: edge.target,
      ...(edge.data?.condition ? { condition: edge.data.condition } : {}),
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
        actor: node.data.actor,
        completeWhen: node.data.completeWhen,
        tools: source?.tools,
        requires: node.data.requires ?? source?.requires,
        produces: node.data.produces ?? source?.produces,
        routes: dedupeRoutes(routeBySource.get(node.id) ?? []),
        line: source?.line,
      };
    }),
  };
}

/** 把 Workflow Definition 中明显的断连问题转换成画布即时提示。 */
function findConnectionIssues(
  definition: WorkflowDefinition,
): Map<string, { severity: 'error' | 'warning'; text: string }> {
  const nodeMap = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const reachable = new Set<string>();

  for (const node of definition.nodes) {
    const routes = dedupeRoutes(node.routes);

    outgoing.set(
      node.id,
      routes.filter((route) => route.target !== node.id).length,
    );

    for (const route of routes) {
      if (!nodeMap.has(route.target) || route.target === node.id) {
        continue;
      }

      incoming.set(route.target, (incoming.get(route.target) ?? 0) + 1);
    }
  }

  const stack = [definition.start];
  while (stack.length) {
    const current = stack.pop();
    if (!current || reachable.has(current)) continue;

    reachable.add(current);

    const node = nodeMap.get(current);
    if (!node) continue;

    for (const route of dedupeRoutes(node.routes)) {
      if (nodeMap.has(route.target)) {
        stack.push(route.target);
      }
    }
  }

  const issues = new Map<string, { severity: 'error' | 'warning'; text: string }>();

  for (const node of definition.nodes) {
    const isStart = definition.start === node.id;
    const terminal = node.type === 'end' || node.type === 'stop';
    const incomingCount = incoming.get(node.id) ?? 0;
    const outgoingCount = outgoing.get(node.id) ?? 0;

    if (node.routes.some((route) => !nodeMap.has(route.target))) {
      issues.set(node.id, {
        severity: 'error',
        text: '存在断开的出口：目标步骤不存在。',
      });
      continue;
    }

    if (!isStart && incomingCount === 0) {
      issues.set(node.id, {
        severity: 'error',
        text: '没有入口连接，这一步无法从 Workflow 进入。',
      });
      continue;
    }

    if (!terminal && outgoingCount === 0) {
      issues.set(node.id, {
        severity: 'error',
        text: '没有出口连接，这一步完成后无法继续。',
      });
      continue;
    }

    if (!reachable.has(node.id)) {
      issues.set(node.id, {
        severity: 'warning',
        text: '虽然存在连接，但从 Workflow start 无法走到这一步。',
      });
    }
  }

  return issues;
}

/**
 * 把 Workflow Definition 投影成引擎无关的 Graph。
 *
 * X6 的实际端口由 JourneyX6Graph 再映射，但业务层仍保存 sourceHandles/targetHandles，
 * 方便属性面板和人工 transition 使用。
 */
export function graphFromDefinition(
  definition: WorkflowDefinition,
  layout: WorkflowLayout,
  snapshot: WorkflowSnapshot,
  onAddStep?: (id: string) => void,
  onAddBranch?: (id: string) => void,
  onDelete?: (id: string) => void,
  onSelectEdge?: (id: string) => void,
  newNodeIds: Set<string> = new Set(),
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodeMap = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Array<{ source: string; outcome: string; id: string }>>();
  const outgoing = new Map<string, Array<{ target: string; outcome: string; id: string }>>();

  for (const node of definition.nodes) {
    dedupeRoutes(node.routes).forEach((route, index) => {
      if (!nodeMap.has(route.target) || route.target === node.id) return;

      const id = node.id + ':' + route.outcome + ':' + route.target + ':' + String(index);

      const nextOutgoing = outgoing.get(node.id) ?? [];
      nextOutgoing.push({ target: route.target, outcome: route.outcome, id });
      outgoing.set(node.id, nextOutgoing);

      const nextIncoming = incoming.get(route.target) ?? [];
      nextIncoming.push({ source: node.id, outcome: route.outcome, id });
      incoming.set(route.target, nextIncoming);
    });
  }

  const issues = findConnectionIssues(definition);

  const nodes: FlowNode[] = definition.nodes.map((item) => {
    const status = stageStatus(snapshot, item.id);
    const sourceRoutes = outgoing.get(item.id) ?? [];
    const targetRoutes = incoming.get(item.id) ?? [];
    const terminal = item.type === 'end' || item.type === 'stop';
    const waiting = snapshot.execution.status === 'waiting'
      && snapshot.execution.currentNodeId === item.id;

    const sourceHandles: HandleSpec[] = sourceRoutes.map((route, index) => ({
      id: sourceHandleId(item.id, index),
      label: route.outcome,
    }));

    const targetHandles: HandleSpec[] = [
      {
        id: targetHandleId(item.id, 0),
        label: targetRoutes.length ? '入口' : '入口',
      },
    ];

    const connectionIssue = issues.get(item.id);

    return {
      id: item.id,
      type: 'journey',
      position: layout.nodes[item.id] ?? { x: 0, y: 0 },
      width: terminal ? 190 : 236,
      height: terminal ? 96 : 180,
      data: {
        title: item.title,
        objective: item.objective,
        nodeType: item.type,
        status,
        completion: item.completion,
        actor: item.actor,
        completeWhen: item.completeWhen,
        requires: item.requires,
        produces: item.produces,
        visible: item.visible,
        isNew: newNodeIds.has(item.id),
        sourceHandles,
        targetHandles,
        ...(connectionIssue
          ? {
              connectionIssue: connectionIssue.severity,
              connectionIssueText: connectionIssue.text,
            }
          : {}),
        onAddStep,
        onAddBranch,
        onDelete,
      },
    };
  });

  const edges: FlowEdge[] = [];

  for (const node of definition.nodes) {
    const validRoutes = dedupeRoutes(node.routes).filter(
      (route) => nodeMap.has(route.target) && route.target !== node.id,
    );

    validRoutes.forEach((route, routeIndex) => {
      const edgeId =
        node.id + ':' + route.outcome + ':' + route.target + ':' + String(routeIndex);

      const targetIncoming = incoming.get(route.target) ?? [];
      const incomingIndex = targetIncoming.findIndex((edge) => edge.id === edgeId);

      edges.push({
        id: edgeId,
        source: node.id,
        target: route.target,
        sourceHandle: sourceHandleId(node.id, routeIndex),
        targetHandle: targetHandleId(route.target, Math.max(0, incomingIndex)),
        data: {
          outcome: route.outcome,
          ...(route.condition ? { condition: route.condition } : {}),
          onSelect: onSelectEdge,
        },
      });
    });
  }

  return { nodes, edges };
}

/** X6 新连线只需要 source/target 节点；outcome 由编辑器按 source 的既有出口自动分配。 */
export interface GraphConnection {
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
}

/**
 * 从 X6 的新建连接转换成业务边。
 *
 * outcome 不从隐藏 port 推断，而是由同一 source 下的现有 outcome 做去重，
 * 因此“从新出口拖线”永远得到一个新的 outcome，不会偷偷生成两条 success。
 */
export function normalizeConnection(
  connection: GraphConnection,
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowEdge | null {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return null;
  }

  if (!nodes.some((node) => node.id === connection.source)) return null;
  if (!nodes.some((node) => node.id === connection.target)) return null;

  const outgoing = edges.filter((edge) => edge.source === connection.source);
  const outcome = nextOutcome(
    outgoing.map((edge) => ({
      outcome: edge.data?.outcome || 'branch',
      target: edge.target,
    })),
    'branch',
  );

  return {
    id:
      connection.source
      + ':'
      + outcome
      + ':'
      + connection.target
      + ':'
      + String(outgoing.length),
    source: connection.source,
    target: connection.target,
    sourceHandle: sourceHandleId(connection.source, outgoing.length),
    targetHandle: TARGET_HANDLE_ID,
    data: { outcome },
  };
}
