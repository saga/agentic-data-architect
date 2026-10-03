import * as z from 'zod';
import {
  JourneyDefinitionSchema,
  JourneyNodeSchema,
  type JourneyDefinition,
  type JourneyNode,
  type JourneyRoute,
} from './journey.js';

/** 可被人工编辑器和 Workflow AI 共用的语义修改操作。 */
export const JourneyWorkflowChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('replace-definition'),
    definition: JourneyDefinitionSchema,
  }).strict(),
  z.object({
    type: z.literal('add-node'),
    node: JourneyNodeSchema,
  }).strict(),
  z.object({
    type: z.literal('update-node'),
    nodeId: z.string().min(1),
    patch: z.object({
      type: z.enum(['task', 'gate', 'review', 'end', 'stop']).optional(),
      title: z.string().min(1).optional(),
      objective: z.string().optional(),
      visible: z.boolean().optional(),
      completion: z.enum(['deterministic', 'agent']).optional(),
      actor: z.enum(['agent', 'human', 'system']).optional(),
      completeWhen: z.string().optional(),
      tools: z.array(z.string()).optional(),
      requires: z.array(z.string()).optional(),
      produces: z.array(z.string()).optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('remove-node'),
    nodeId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('add-route'),
    nodeId: z.string().min(1),
    route: z.object({
      outcome: z.string().min(1),
      target: z.string().min(1),
      condition: z.string().min(1).optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('update-route'),
    nodeId: z.string().min(1),
    outcome: z.string().min(1),
    patch: z.object({
      target: z.string().min(1).optional(),
      /** null 表示清除条件；undefined 表示不改。 */
      condition: z.string().min(1).nullable().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('remove-route'),
    nodeId: z.string().min(1),
    outcome: z.string().min(1),
  }).strict(),
]);

export type JourneyWorkflowChange = z.infer<typeof JourneyWorkflowChangeSchema>;
export const JourneyWorkflowChangesSchema = z.array(JourneyWorkflowChangeSchema).min(1).max(60);

export interface JourneyAnalysisIssue {
  severity: 'warning' | 'error';
  code:
    | 'multiple-conditional-routes'
    | 'conditional-route-without-fallback'
    | 'missing-required-producer'
    | 'duplicate-produced-output';
  nodeId?: string;
  message: string;
}

function cloneDefinition(definition: JourneyDefinition): JourneyDefinition {
  return {
    id: definition.id,
    start: definition.start,
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      visible: node.visible,
      completion: node.completion,
      actor: node.actor,
      routes: node.routes.map((route) => ({
        outcome: route.outcome,
        target: route.target,
        ...(route.condition ? { condition: route.condition } : {}),
        ...(route.line !== undefined ? { line: route.line } : {}),
      })),
      ...(node.objective ? { objective: node.objective } : {}),
      ...(node.completeWhen ? { completeWhen: node.completeWhen } : {}),
      ...(node.tools?.length ? { tools: [...node.tools] } : {}),
      ...(node.requires?.length ? { requires: [...node.requires] } : {}),
      ...(node.produces?.length ? { produces: [...node.produces] } : {}),
      ...(node.line !== undefined ? { line: node.line } : {}),
    })),
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 应用语义 Patch。
 *
 * 这个函数不依赖 React Flow，因此人工编辑、AI 编辑、CLI 编辑都可以共用。
 */
export function applyJourneyWorkflowChanges(
  definitionInput: JourneyDefinition,
  changesInput: JourneyWorkflowChange[],
): JourneyDefinition {
  let definition = cloneDefinition(definitionInput);

  for (const change of JourneyWorkflowChangesSchema.parse(changesInput)) {
    switch (change.type) {
      case 'replace-definition':
        definition = cloneDefinition(change.definition);
        break;

      case 'add-node':
        if (definition.nodes.some((node) => node.id === change.node.id)) {
          throw new Error('不能新增重复节点：' + change.node.id);
        }
        const node = change.node;
        definition.nodes.push({
          id: node.id,
          type: node.type,
          title: node.title,
          visible: node.visible,
          completion: node.completion,
          actor: node.actor,
          routes: node.routes.map((route) => ({
            outcome: route.outcome,
            target: route.target,
            ...(route.condition ? { condition: route.condition } : {}),
            ...(route.line !== undefined ? { line: route.line } : {}),
          })),
          ...(node.objective ? { objective: node.objective } : {}),
          ...(node.completeWhen ? { completeWhen: node.completeWhen } : {}),
          ...(node.tools?.length ? { tools: [...node.tools] } : {}),
          ...(node.requires?.length ? { requires: [...node.requires] } : {}),
          ...(node.produces?.length ? { produces: [...node.produces] } : {}),
          ...(node.line !== undefined ? { line: node.line } : {}),
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
          throw new Error('不能删除 Workflow start 节点：' + change.nodeId);
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
        if (node.routes.some((route) => normalize(route.outcome) === normalize(change.route.outcome))) {
          throw new Error(node.id + ' 已存在 outcome=' + change.route.outcome);
        }
        node.routes.push({
          outcome: change.route.outcome,
          target: change.route.target,
          ...(change.route.condition ? { condition: change.route.condition } : {}),
        });
        break;
      }

      case 'update-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到节点：' + change.nodeId);
        const index = node.routes.findIndex((route) => normalize(route.outcome) === normalize(change.outcome));
        if (index < 0) throw new Error(node.id + ' 不存在 outcome=' + change.outcome);
        const next: JourneyRoute = { ...(node.routes[index] as JourneyRoute) };
        if (change.patch.target !== undefined) next.target = change.patch.target;
        if (change.patch.condition === null) delete next.condition;
        else if (change.patch.condition !== undefined) next.condition = change.patch.condition;
        node.routes[index] = next;
        break;
      }

      case 'remove-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到节点：' + change.nodeId);
        node.routes = node.routes.filter((route) => normalize(route.outcome) !== normalize(change.outcome));
        break;
      }
    }
  }

  return JourneyDefinitionSchema.parse(definition);
}

/** 为 AI/审计/预览生成稳定的语义 diff。 */
export function diffJourneyWorkflowDefinitions(
  before: JourneyDefinition,
  after: JourneyDefinition,
): JourneyWorkflowChange[] {
  if (before.id !== after.id || before.start !== after.start) {
    return [{ type: 'replace-definition', definition: after }];
  }

  const changes: JourneyWorkflowChange[] = [];
  const beforeMap = new Map(before.nodes.map((node) => [node.id, node]));
  const afterMap = new Map(after.nodes.map((node) => [node.id, node]));

  for (const node of before.nodes) {
    if (!afterMap.has(node.id)) changes.push({ type: 'remove-node', nodeId: node.id });
  }
  for (const node of after.nodes) {
    if (!beforeMap.has(node.id)) changes.push({ type: 'add-node', node });
  }

  const nodeComparable = (node: JourneyNode) => ({
    type: node.type,
    title: node.title,
    objective: node.objective,
    visible: node.visible,
    completion: node.completion,
    actor: node.actor,
    completeWhen: node.completeWhen,
    tools: node.tools,
    requires: node.requires,
    produces: node.produces,
  });

  for (const [id, oldNode] of beforeMap) {
    const newNode = afterMap.get(id);
    if (!newNode) continue;

    if (JSON.stringify(nodeComparable(oldNode)) !== JSON.stringify(nodeComparable(newNode))) {
      changes.push({
        type: 'update-node',
        nodeId: id,
        patch: nodeComparable(newNode),
      });
    }

    const oldRoutes = new Map(oldNode.routes.map((route) => [normalize(route.outcome), route]));
    const newRoutes = new Map(newNode.routes.map((route) => [normalize(route.outcome), route]));

    for (const oldRoute of oldNode.routes) {
      if (!newRoutes.has(normalize(oldRoute.outcome))) {
        changes.push({ type: 'remove-route', nodeId: id, outcome: oldRoute.outcome });
      }
    }

    for (const newRoute of newNode.routes) {
      const oldRoute = oldRoutes.get(normalize(newRoute.outcome));
      if (!oldRoute) {
        changes.push({
          type: 'add-route',
          nodeId: id,
          route: {
            outcome: newRoute.outcome,
            target: newRoute.target,
            ...(newRoute.condition ? { condition: newRoute.condition } : {}),
          },
        });
      } else if (
        oldRoute.target !== newRoute.target
        || oldRoute.condition !== newRoute.condition
      ) {
        changes.push({
          type: 'update-route',
          nodeId: id,
          outcome: oldRoute.outcome,
          patch: {
            target: newRoute.target,
            condition: newRoute.condition ?? null,
          },
        });
      }
    }
  }

  return changes;
}

/**
 * 对 Workflow 做轻量静态分析。
 * 不尝试计算真正的业务逻辑，只发现作者最容易写错的结构。
 */
export function analyzeJourneyWorkflow(
  definition: JourneyDefinition,
): JourneyAnalysisIssue[] {
  const issues: JourneyAnalysisIssue[] = [];
  const producedBy = new Map<string, string[]>();

  for (const node of definition.nodes) {
    for (const output of node.produces ?? []) {
      const key = normalize(output);
      if (!key) continue;
      producedBy.set(key, [...(producedBy.get(key) ?? []), node.id]);
    }
  }

  for (const node of definition.nodes) {
    const conditionalRoutes = node.routes.filter((route) => Boolean(route.condition));

    if (conditionalRoutes.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'multiple-conditional-routes',
        nodeId: node.id,
        message: node.id + ' 有多个条件分支；条件同时成立时按 DSL 顺序命中前面的出口。',
      });
    }

    if (conditionalRoutes.length > 0 && node.routes.every((route) => Boolean(route.condition))) {
      issues.push({
        severity: 'warning',
        code: 'conditional-route-without-fallback',
        nodeId: node.id,
        message: node.id + ' 没有无条件 fallback 出口；没有条件命中时可能无法继续。',
      });
    }

    for (const required of node.requires ?? []) {
      if (!producedBy.has(normalize(required))) {
        issues.push({
          severity: 'warning',
          code: 'missing-required-producer',
          nodeId: node.id,
          message: node.id + ' 依赖产物“' + required + '”，但当前图中没有声明对应 produces。',
        });
      }
    }
  }

  for (const [output, producers] of producedBy) {
    if (producers.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'duplicate-produced-output',
        message: '产物“' + output + '”由多个节点声明产生：' + producers.join('、') + '。',
      });
    }
  }

  return issues;
}

/** 只允许修改选中节点及其相邻节点/边，避免 AI 无意中重写整张图。 */
export function validateJourneyChangeScope(
  definition: JourneyDefinition,
  changes: JourneyWorkflowChange[],
  selectedNodeId?: string,
): string[] {
  if (!selectedNodeId) return [];
  const selected = definition.nodes.find((node) => node.id === selectedNodeId);
  if (!selected) return ['选中的节点不存在：' + selectedNodeId];

  const allowed = new Set([selectedNodeId]);
  for (const node of definition.nodes) {
    if (node.routes.some((route) => route.target === selectedNodeId)) allowed.add(node.id);
    if (selected.routes.some((route) => route.target === node.id)) allowed.add(node.id);
  }

  const issues: string[] = [];
  for (const change of changes) {
    switch (change.type) {
      case 'replace-definition':
        issues.push('“仅修改当前步骤”模式不能整体替换 Workflow。');
        break;
      case 'add-node':
        // 新节点本身可以新增，但后续 route 必须连接到允许范围。
        break;
      case 'update-node':
      case 'remove-node':
      case 'add-route':
      case 'update-route':
      case 'remove-route':
        if (!allowed.has(change.nodeId)) {
          issues.push('AI 修改超出了选中节点附近的范围：' + change.nodeId);
        }
        if (change.type === 'update-route' && change.patch.target && !allowed.has(change.patch.target)) {
          issues.push('AI 新连接目标超出了选中节点附近的范围：' + change.patch.target);
        }
        if (change.type === 'add-route' && !allowed.has(change.route.target) && change.route.target !== selectedNodeId) {
          issues.push('AI 新连接目标超出了选中节点附近的范围：' + change.route.target);
        }
        break;
    }
  }
  return [...new Set(issues)];
}

/** 给 UI 的短描述。 */
export function describeJourneyWorkflowChange(change: JourneyWorkflowChange): string {
  switch (change.type) {
    case 'replace-definition':
      return '重新生成整张工作地图';
    case 'add-node':
      return '新增步骤：' + change.node.title;
    case 'update-node':
      return '修改步骤：' + change.nodeId;
    case 'remove-node':
      return '删除步骤：' + change.nodeId;
    case 'add-route':
      return '新增分支：' + change.nodeId + ' → ' + change.route.target + '（' + change.route.outcome + '）';
    case 'update-route':
      return '修改分支：' + change.nodeId + ' / ' + change.outcome;
    case 'remove-route':
      return '删除分支：' + change.nodeId + ' / ' + change.outcome;
  }
}
