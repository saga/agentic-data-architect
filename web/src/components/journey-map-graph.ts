import type { CSSProperties } from 'react';
import {
  MarkerType,
  Position,
  type Connection,
} from '@xyflow/react';
import {
  EDGE_TYPE,
  STATUS_CLASS,
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

/** 给每个 source Handle 一个稳定 ID。
 *
 * React Flow 的多 Handle 场景要求每条连接点有唯一 id。
 * 这里故意使用“节点 + 顺序”，不要把 outcome 直接塞进 id，
 * 因为用户编辑 outcome 时不应该同时破坏 React Flow 的连接身份。
 */
export function sourceHandleId(nodeId: string, index: number): string {
  return nodeId + '-out-' + String(index);
}

/** 给每个 target Handle 一个稳定 ID。 */
export function targetHandleId(nodeId: string, index: number): string {
  return nodeId + '-in-' + String(index);
}

/** 多 Handle 时把连接点平均分布在节点上下，而不是全部挤在正中间。 */
export function handleStyle(index: number, total: number): CSSProperties {
  const top = ((index + 1) / (total + 1)) * 100;
  return { top: String(top) + '%' };
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

/** 为新增分支生成不重复的 outcome。
 *
 * outcome 本身就是 DSL 的分支名字，因此必须在同一 source 节点内唯一。
 * 例如已有 success 时自动给新分支一个 branch，而不是伪造第二个 success。
 */
export function nextOutcome(routes: JourneyRouteDefinitionLike[], base: string): string {
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
 * 浏览器侧应用语义 Patch。
 *
 * React Flow 只是画布适配层；AI 预览真正应用时也通过这里回到 Workflow Definition。
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
      routes: node.routes.map((route) => ({ ...route })),
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
          routes: change.node.routes.map((route) => ({ ...route })),
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
        node.routes.push({ ...change.route });
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

/** 保存 React Flow 节点位置。
 *
 * Workflow 语义仍然由 Markdown/Definition 保存；这里仅保存 Canvas layout。
 * elk-v2 是“需要重新自动排版”的版本标记，不代表 Workflow 版本。
 */
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
    engine: 'elk-v2',
    nodes: result,
  };
}

/** 把当前 React Flow graph 还原为 Workflow Definition。
 *
 * 这是编辑器最重要的边界：
 * React Flow 只负责编辑；
 * 保存/验证/执行时，最终都重新回到统一的 Workflow Definition。
 */
export function definitionFromGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  base: WorkflowDefinition,
): WorkflowDefinition {
  const routeBySource = new Map<string, JourneyRouteDefinitionLike[]>();

  for (const edge of edges) {
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
        routes: routeBySource.get(node.id) ?? [],
        line: source?.line,
      };
    }),
  };
}

/** 把当前 graph 中的结构问题转换成用户能直接理解的提示。
 *
 * 注意：
 * - start 没有 incoming 是正常的；
 * - end/stop 没有 outgoing 是正常的；
 * - 其它节点缺入口/出口才是结构问题；
 * - route 指向不存在节点属于更明确的 error；
 * - 有入口但从 start 实际走不到，属于 warning。
 */
function findConnectionIssues(
  definition: WorkflowDefinition,
): Map<string, { severity: 'error' | 'warning'; text: string }> {
  const nodeMap = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const reachable = new Set<string>();

  for (const node of definition.nodes) {
    outgoing.set(node.id, node.routes.length);

    for (const route of node.routes) {
      if (!nodeMap.has(route.target)) {
        continue;
      }

      incoming.set(route.target, (incoming.get(route.target) ?? 0) + 1);
    }
  }

  // 从 Workflow start 做一次很轻量的图遍历。
  // 这里不是替代服务端 validation，而是为了让 UI 在编辑时即时指出明显断开的节点。
  const stack = [definition.start];
  while (stack.length) {
    const current = stack.pop();
    if (!current || reachable.has(current)) continue;

    reachable.add(current);

    const node = nodeMap.get(current);
    if (!node) continue;

    for (const route of node.routes) {
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

/** 把 Workflow Definition 投影成 React Flow。
 *
 * 这里故意让“锁定模式”和“编辑模式”走同一份建图代码。
 * 两者的区别只在 draggable/connectable/selectable，而不是节点/边是否存在。
 */
export function graphFromDefinition(
  definition: WorkflowDefinition,
  layout: WorkflowLayout,
  snapshot: WorkflowSnapshot,
  onSelectNode?: (id: string) => void,
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
    node.routes.forEach((route, index) => {
      // 即使目标不存在，也不创建一条无效 React Flow edge。
      // 但它会通过 findConnectionIssues 显示在节点上。
      if (!nodeMap.has(route.target)) return;

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

  const issues = findConnectionIssues(definition);

  const nodes: FlowNode[] = definition.nodes.map((item) => {
    const status = stageStatus(snapshot, item.id);
    const sourceRoutes = outgoing.get(item.id) ?? [];
    const targetRoutes = incoming.get(item.id) ?? [];

    const sourceHandles: HandleSpec[] = sourceRoutes.map((route, index) => ({
      id: sourceHandleId(item.id, index),
      label: route.outcome,
    }));

    const targetHandles: HandleSpec[] = targetRoutes.map((route, index) => ({
      id: targetHandleId(item.id, index),
      label: route.outcome,
    }));

    // 没有真实 route 的节点仍然保留一个“可连接”的虚拟 Handle。
    // 编辑模式可以直接从这里连出去；锁定模式同样显示它，但禁止拖动。
    if (!sourceHandles.length && item.type !== 'end' && item.type !== 'stop') {
      sourceHandles.push({
        id: sourceHandleId(item.id, 0),
        label: '新增出口',
      });
    }

    if (!targetHandles.length) {
      targetHandles.push({
        id: targetHandleId(item.id, 0),
        label: '入口',
      });
    }

    const connectionIssue = issues.get(item.id);
    const terminal = item.type === 'end' || item.type === 'stop';
    const waiting = snapshot.execution.status === 'waiting'
      && snapshot.execution.currentNodeId === item.id;

    return {
      id: item.id,
      type: 'journey',
      position: layout.nodes[item.id] ?? { x: 0, y: 0 },
      draggable: true,
      selectable: true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
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
        onSelect: onSelectNode,
        onAddStep,
        onAddBranch,
        onDelete,
      },
      className:
        'journey-flow-node journey-flow-node-stage '
        + STATUS_CLASS[status]
        + ' journey-flow-node-type-' + item.type
        + ' journey-flow-node-actor-' + item.actor
        + (waiting ? ' journey-flow-node-waiting' : '')
        + (!item.visible ? ' journey-flow-node-deemphasized' : '')
        + (connectionIssue ? ' journey-flow-node-connection-' + connectionIssue.severity : '')
        + (newNodeIds.has(item.id) ? ' journey-flow-node-new' : ''),
      style: {
        width: terminal ? 190 : 236,
      },
    };
  });

  const edges: FlowEdge[] = [];

  for (const node of definition.nodes) {
    const validRoutes = node.routes.filter((route) => nodeMap.has(route.target));

    validRoutes.forEach((route, routeIndex) => {
      const edgeId =
        node.id + ':' + route.outcome + ':' + route.target + ':' + String(routeIndex);

      const targetIncoming = incoming.get(route.target) ?? [];
      const incomingIndex = targetIncoming.findIndex((edge) => edge.id === edgeId);

      const sourceCompleted = snapshot.state.completedNodeIds.includes(node.id);
      const isCurrent = snapshot.state.currentNodeId === node.id;

      edges.push({
        id: edgeId,
        source: node.id,
        target: route.target,
        sourceHandle: sourceHandleId(node.id, routeIndex),
        targetHandle: targetHandleId(route.target, Math.max(0, incomingIndex)),
        type: EDGE_TYPE,
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: isCurrent,
        className:
          'journey-flow-edge'
          + (sourceCompleted ? ' journey-flow-edge-traversed' : '')
          + (isCurrent ? ' journey-flow-edge-current' : ''),
        data: {
          outcome: route.outcome,
          ...(route.condition ? { condition: route.condition } : {}),
          // 分支多时标签也需要错开，否则“success / retry / rollback”会叠成一团。
          labelOffsetY:
            (routeIndex - (validRoutes.length - 1) / 2) * 20
            + (Math.max(0, incomingIndex) - (Math.max(0, targetIncoming.length) - 1) / 2) * 10,
          onSelect: onSelectEdge,
        },
      });
    });
  }

  return { nodes, edges };
}

/** 通过鼠标从一个 Handle 拖到另一个节点时，创建一条新的 Flow edge。
 *
 * outcome 默认使用 branch：
 * 用户可以直接点击边标签/右侧属性，把它改成 needs-input、retry 等正式 outcome。
 */
export function normalizeConnection(
  connection: Connection,
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowEdge | null {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return null;
  }

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

  const sourceHandle = sourceHandleId(connection.source, outgoing.length);
  const targetHandle = targetHandleId(connection.target, incoming.length);

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
    sourceHandle,
    targetHandle,
    type: EDGE_TYPE,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: {
      outcome,
      labelOffsetY: (outgoing.length - Math.floor(outgoing.length / 2)) * 10,
    },
  };
}
