/**
 * Legacy Modernization Journey：把 Data Analyst / Data Architect 的工作组织成一张可执行路线图。
 *
 * Markdown Workflow 只描述路线和出口；具体怎么查仍由 Skill + Tool 决定。
 * 参考 copilot-server-agent 的 @flow / @task / @gate / @end / @stop 设计，
 * 这里只实现本项目当前真正需要的轻量部分，不引入完整流程引擎。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { config } from '../config.js';
import type { WorkflowId } from '../investigation/schemas.js';
import { parseSkillManifest } from '../skills/catalog.js';

export type JourneyNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';
export type JourneyCompletionMode = 'deterministic' | 'agent';
export type JourneyActor = 'agent' | 'human' | 'system';
export type JourneyStatus = 'completed' | 'current' | 'locked' | 'future';

export interface JourneyRoute {
  outcome: string;
  target: string;
  /** 可选的确定性路由条件；按 DSL 顺序先匹配者优先。 */
  condition?: string | undefined;
  line?: number | undefined;
}

export interface JourneyNode {
  id: string;
  type: JourneyNodeType;
  title: string;
  objective?: string | undefined;
  visible: boolean;
  /** deterministic 有明确 completeWhen；agent 由 Agent 选择 outcome。 */
  completion: JourneyCompletionMode;
  /** 主要执行者：Agent、人或系统；默认不改变现有 Workflow 行为。 */
  actor: JourneyActor;
  completeWhen?: string | undefined;
  /** 提示性工具标签，不决定 Agent 实际可用工具、MCP 权限或授权边界。 */
  tools?: string[] | undefined;
  /** 这一步依赖的前置成果；只是轻量数据依赖声明，不执行变量解析。 */
  requires?: string[] | undefined;
  /** 这一步产出的工作成果；供后续步骤理解依赖关系。 */
  produces?: string[] | undefined;
  routes: JourneyRoute[];
  line?: number | undefined;
}

export interface JourneyDefinition {
  id: string;
  start: string;
  nodes: JourneyNode[];
}

export interface ParsedJourney {
  definition?: JourneyDefinition;
  issues: string[];
}

export interface JourneyFacts {
  goal: string;
  /** Architecture Assessment 使用的确定性计数；Legacy 路线不需要填。 */
  findingCount?: number;
  recommendationCount?: number;
  roadmapItemCount?: number;
  currentState: {
    datasets: number;
    semanticAssets: number;
    parseFailures: number;
  } | null;
  unknowns: string[];
  highGapKinds: string[];
  targetComponentCount: number;
  mappingCount: number;
  blockingValidationReady: number;
  blockingValidationTotal: number;
}

export interface JourneyStage {
  id: string;
  title: string;
  objective: string;
  status: JourneyStatus;
  nodeType: JourneyNodeType;
  unlocked: boolean;
}

export interface JourneyPendingInteraction {
  id: string;
  nodeId: string;
  reason: string;
  requestedAt: string;
}

export type JourneyRunEventType =
  | 'workflow-started'
  | 'node-started'
  | 'node-completed'
  | 'node-waiting'
  | 'node-failed'
  | 'workflow-completed'
  | 'workflow-stopped'
  | 'transition-rejected';

export interface JourneyRunEvent {
  id: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  type: JourneyRunEventType;
  timestamp: string;
  nodeId?: string;
  outcome?: string;
  error?: string;
  data?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
  };
}

export interface JourneyExecution {
  workflowId: string;
  workflowVersion: number;
  runId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  status: 'active' | 'waiting' | 'completed' | 'stopped';
  pendingInteraction?: JourneyPendingInteraction | undefined;
}

export interface JourneyState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: JourneyStage[];
  execution: JourneyExecution;
}

/**
 * 解析 Markdown Workflow。
 *
 * 支持两种路线写法：Markdown 列表中的 "- success -> next-task"，
 * 以及 Workflow 顶部常见的 "start -> first-task"。
 *
 * parser 只记录作者写了什么，不解释 completeWhen 的业务含义。
 * 普通 Markdown 仍然可以照常写给人看。
 */
export function parseJourneyMarkdown(markdown: string): ParsedJourney {
  const lines = markdown.split(/\r?\n/);
  const nodes: JourneyNode[] = [];
  const issues: string[] = [];
  let flowId: string | undefined;
  let declaredStart: string | undefined;
  let current: {
    id: string;
    type: JourneyNodeType;
    title: string;
    attrs: Record<string, string>;
    routes: JourneyRoute[];
    line: number;
  } | undefined;

  const commitNode = () => {
    if (!current) return;
    nodes.push({
      id: current.id,
      type: current.type,
      title: current.attrs.title || current.title,
      objective: current.attrs.objective,
      visible: current.attrs.visible !== 'false',
      completion: current.attrs.completion === 'agent' || current.attrs.completion === 'deterministic'
        ? current.attrs.completion
        : current.attrs.completeWhen
          ? 'deterministic'
          : 'agent',
      actor: current.attrs.actor === 'human' || current.attrs.actor === 'system'
        ? current.attrs.actor
        : current.type === 'review'
          ? 'human'
          : 'agent',
      completeWhen: current.attrs.completeWhen,
      tools: current.attrs.tools
        ? current.attrs.tools.split(',').map((item) => item.trim()).filter(Boolean)
        : undefined,
      requires: current.attrs.requires
        ? current.attrs.requires.split(',').map((item) => item.trim()).filter(Boolean)
        : undefined,
      produces: current.attrs.produces
        ? current.attrs.produces.split(',').map((item) => item.trim()).filter(Boolean)
        : undefined,
      routes: current.routes,
      line: current.line,
    });
    current = undefined;
  };

  const headingPattern = /^##\s+@(flow|task|gate|review|end|stop)\s+([A-Za-z0-9._:-]+)\s*$/;
  const routePattern = /^(?:[-*]\s+)?([A-Za-z0-9._:-]+)\s*->\s*([A-Za-z0-9._:-]+)(?:\s+if\s+([A-Za-z0-9._:-]+))?\s*$/;
  const attrPattern = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index].trim();
    if (!raw) continue;

    const heading = headingPattern.exec(raw);
    if (heading) {
      commitNode();
      const kind = heading[1];
      const id = heading[2];
      if (kind === 'flow') {
        if (flowId) issues.push('第 ' + lineNumber + ' 行重复定义 @flow ' + id);
        flowId = id;
      } else {
        current = {
          id,
          type: kind as JourneyNodeType,
          title: id,
          attrs: {},
          routes: [],
          line: lineNumber,
        };
      }
      continue;
    }

    const route = routePattern.exec(raw);
    if (!current && route && route[1].toLowerCase() === 'start') {
      declaredStart = route[2];
      continue;
    }

    if (!current) continue;

    if (route) {
      current.routes.push({
        outcome: route[1].toLowerCase(),
        target: route[2],
        ...(route[3] ? { condition: route[3].toLowerCase() } : {}),
        line: lineNumber,
      });
      continue;
    }

    const attr = attrPattern.exec(raw);
    if (attr && current.routes.length === 0) {
      current.attrs[attr[1]] = attr[2];
      continue;
    }

    if (current.title === current.id && !raw.startsWith('#')) {
      current.title = raw.replace(/^[-*]\s+/, '').trim();
    }
  }

  commitNode();

  if (!flowId) issues.push('没有找到 @flow');

  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) issues.push('重复的 workflow node：' + node.id);
    seen.add(node.id);
  }

  const startNode = nodes.find((node) => node.id === 'start');
  const startRoute = startNode?.routes.find((route) => route.outcome === 'success');
  const startTarget = declaredStart ?? startRoute?.target;
  if (!startTarget) {
    issues.push('Workflow 必须定义 start -> <node>');
  } else if (!nodes.some((node) => node.id === startTarget)) {
    issues.push('start 指向不存在的节点：' + startTarget);
  }

  for (const node of nodes) {
    for (const route of node.routes) {
      if (!nodes.some((candidate) => candidate.id === route.target)) {
        issues.push(node.id + ' 第 ' + route.line + ' 行指向不存在的节点：' + route.target);
      }
    }
  }

  if (!flowId || !startTarget) return { issues };

  const definition: JourneyDefinition = {
    id: flowId,
    start: startTarget,
    nodes: nodes.filter((node) => node.id !== 'start'),
  };
  issues.push(...validateJourneyDefinition(definition));
  return {
    definition,
    issues: [...new Set(issues)],
  };
}

/** 根据 Session workflow 加载对应的 Markdown 路线。 */
export async function loadWorkflowJourney(workflowId: WorkflowId): Promise<JourneyDefinition> {
  const skillPath = path.join(config.skillsDir, workflowId, 'SKILL.md');
  const markdown = await fs.readFile(skillPath, 'utf8');
  const manifest = parseSkillManifest(markdown, skillPath);
  if (manifest.name !== workflowId) {
    throw new Error('Workflow ' + workflowId + ' 对应 Skill 名称不一致：' + manifest.name);
  }
  if (manifest.metadata.kind !== 'workflow') {
    throw new Error('Skill ' + workflowId + ' 的 kind=' + manifest.metadata.kind + '，不能作为 Workflow 加载。');
  }
  const result = parseJourneyMarkdown(markdown);
  if (!result.definition || result.issues.length) {
    throw new Error(
      `Workflow ${workflowId} 定义无效：\n` + result.issues.join('\n'),
    );
  }
  return result.definition;
}

/** 保留旧调用入口，避免 Legacy Modernization 代码一次性大改。 */
export async function loadModernizationJourney(): Promise<JourneyDefinition> {
  return loadWorkflowJourney('legacy-modernization');
}

/** 当前版本已支持的 deterministic completion 条件。 */
export const KNOWN_COMPLETION_CONDITIONS = [
  'goal',
  'current-state',
  'data-truth',
  'investigation',
  'current-state-ready',
  'target',
  'mapping',
  'validation',
  'cutover',
  'assessment-current-state',
  'assessment-findings',
  'assessment-recommendation',
  'assessment-roadmap',
] as const;

function conditionPassed(condition: string | undefined, facts: JourneyFacts): boolean {
  switch (condition) {
    case 'goal':
      return Boolean(facts.goal.trim());
    case 'current-state':
      return Boolean(facts.currentState && facts.currentState.datasets > 0);
    case 'data-truth':
      return Boolean(
        facts.currentState
        && facts.currentState.datasets > 0
        && facts.currentState.parseFailures === 0
        && !facts.highGapKinds.some((kind) =>
          ['discovery', 'source-of-truth'].includes(kind)),
      );
    case 'investigation':
      return Boolean(
        facts.currentState
        && !facts.highGapKinds.some((kind) =>
          ['discovery', 'lineage', 'source-of-truth'].includes(kind)),
      );
    case 'current-state-ready':
      return Boolean(
        facts.currentState
        && facts.currentState.datasets > 0
        && !facts.highGapKinds.some((kind) =>
          ['discovery', 'lineage', 'source-of-truth'].includes(kind)),
      );
    case 'target':
      return facts.targetComponentCount > 0;
    case 'mapping':
      return facts.mappingCount > 0;
    case 'validation':
      return facts.blockingValidationTotal > 0
        && facts.blockingValidationReady >= facts.blockingValidationTotal;
    case 'assessment-current-state':
      return Boolean(
        facts.currentState
        && facts.currentState.datasets > 0
        && !facts.highGapKinds.some((kind) => ['discovery', 'lineage'].includes(kind)),
      );
    case 'assessment-findings':
      return (facts.findingCount ?? 0) > 0;
    case 'assessment-recommendation':
      return (facts.recommendationCount ?? 0) > 0;
    case 'assessment-roadmap':
      return (facts.roadmapItemCount ?? 0) > 0;
    default:
      return false;
  }
}

/** 校验 Workflow 图；允许 retry/rollback 环，但所有节点必须最终可到达终点。 */
export function validateJourneyDefinition(definition: JourneyDefinition): string[] {
  const issues: string[] = [];
  const nodeMap = new Map<string, JourneyNode>();

  if (!/^[A-Za-z0-9._:-]+$/.test(definition.id)) {
    issues.push('Workflow id 只能包含字母、数字、.、_、:、-。');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(definition.start)) {
    issues.push('Workflow start 节点 ID 不合法：' + definition.start);
  }

  for (const node of definition.nodes) {
    if (nodeMap.has(node.id)) issues.push('重复的 workflow node：' + node.id);
    nodeMap.set(node.id, node);

    if (node.actor !== 'agent' && node.actor !== 'human' && node.actor !== 'system') {
      issues.push(node.id + ' 使用了未知 actor：' + node.actor);
    }

    if (node.completion === 'deterministic' && !node.completeWhen && node.type !== 'end' && node.type !== 'stop') {
      issues.push(node.id + ' 使用 deterministic completion，但没有 completeWhen。');
    }
    if (node.completeWhen && !(KNOWN_COMPLETION_CONDITIONS as readonly string[]).includes(node.completeWhen)) {
      issues.push(node.id + ' 使用了未知 completeWhen：' + node.completeWhen);
    }
    if ((node.type === 'end' || node.type === 'stop') && node.completeWhen) {
      issues.push(node.id + ' 是终点节点，不需要 completeWhen。');
    }
  }

  if (!nodeMap.has(definition.start)) {
    issues.push('start 指向不存在的节点：' + definition.start);
  }

  const outgoing = new Map<string, JourneyRoute[]>();
  const incoming = new Map<string, string[]>();
  for (const node of definition.nodes) {
    const outcomes = new Set<string>();
    for (const route of node.routes) {
      if (!nodeMap.has(route.target)) {
        issues.push(node.id + ' 第 ' + route.line + ' 行指向不存在的节点：' + route.target);
      }
      if (route.condition && !(KNOWN_COMPLETION_CONDITIONS as readonly string[]).includes(route.condition)) {
        issues.push(node.id + ' 使用了未知 route condition：' + route.condition);
      }
      const normalizedOutcome = route.outcome.toLowerCase();
      if (outcomes.has(normalizedOutcome)) {
        issues.push(node.id + ' 重复使用 outcome：' + route.outcome);
      }
      outcomes.add(normalizedOutcome);
      outgoing.set(node.id, [...(outgoing.get(node.id) ?? []), route]);
      incoming.set(route.target, [...(incoming.get(route.target) ?? []), node.id]);
    }

    if (node.type === 'end' || node.type === 'stop') {
      if (node.routes.length) issues.push(node.id + ' 是终点节点，不能继续连出分支。');
    } else if (!node.routes.length) {
      issues.push(node.id + ' 没有任何出口。请至少连接一个 outcome。');
    }
  }

  const reachable = new Set<string>();
  if (nodeMap.has(definition.start)) {
    const queue = [definition.start];
    while (queue.length) {
      const current = queue.shift() as string;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const route of outgoing.get(current) ?? []) {
        if (nodeMap.has(route.target)) queue.push(route.target);
      }
    }
  }
  for (const node of definition.nodes) {
    if (!reachable.has(node.id)) issues.push('从 start 无法到达节点：' + node.id);
  }

  const terminals = definition.nodes
    .filter((node) => node.type === 'end' || node.type === 'stop')
    .map((node) => node.id);
  if (!terminals.length) issues.push('Workflow 至少需要一个 @end 或 @stop 终点。');

  const canReachTerminal = new Set(terminals);
  const reverseQueue = [...terminals];
  while (reverseQueue.length) {
    const current = reverseQueue.shift() as string;
    for (const source of incoming.get(current) ?? []) {
      if (canReachTerminal.has(source)) continue;
      canReachTerminal.add(source);
      reverseQueue.push(source);
    }
  }
  for (const node of definition.nodes) {
    if (!canReachTerminal.has(node.id)) {
      issues.push('节点无法沿任何路径到达 @end / @stop：' + node.id);
    }
  }

  return [...new Set(issues)];
}

/** 为 Workflow 版本建立执行状态。 */
export function initialJourneyExecution(
  definition: JourneyDefinition,
  workflowVersion = 0,
): JourneyExecution {
  const startNode = definition.nodes.find((node) => node.id === definition.start);
  const waitingForHuman = startNode?.actor === 'human';
  return {
    workflowId: definition.id,
    workflowVersion,
    runId: definition.id + '-v' + String(workflowVersion),
    currentNodeId: definition.start,
    completedNodeIds: [],
    status: waitingForHuman ? 'waiting' : 'active',
    ...(waitingForHuman
      ? {
          pendingInteraction: {
            id: 'pending-' + definition.id + '-' + String(workflowVersion),
            nodeId: definition.start,
            reason: '等待人工完成“' + (startNode?.title ?? definition.start) + '”。',
            requestedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}

/** 从当前节点选择 outcome；不存在的 outcome 永远不能推进状态机。 */
export function applyJourneyTransition(
  definition: JourneyDefinition,
  execution: JourneyExecution,
  nodeId: string,
  outcome: string,
): JourneyExecution {
  if (execution.currentNodeId !== nodeId) {
    throw new Error(
      'Workflow 当前节点是 ' + execution.currentNodeId + '，不能从 ' + nodeId + ' 推进。',
    );
  }

  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error('Workflow 当前节点不存在：' + nodeId);

  const route = node.routes.find(
    (item) => item.outcome.toLowerCase() === outcome.toLowerCase(),
  );
  if (!route) {
    throw new Error(
      'Workflow 节点 ' + nodeId + ' 没有 outcome=' + outcome + ' 的出口。',
    );
  }

  const target = definition.nodes.find((item) => item.id === route.target);
  if (!target) throw new Error('Workflow target 不存在：' + route.target);

  const completed = new Set(execution.completedNodeIds);
  if (target.id !== nodeId) completed.add(nodeId);

  const waitingForHuman = target.actor === 'human'
    && target.type !== 'end'
    && target.type !== 'stop';
  const nextStatus: JourneyExecution['status'] = target.type === 'end'
    ? 'completed'
    : target.type === 'stop'
      ? 'stopped'
      : waitingForHuman
        ? 'waiting'
        : 'active';

  const { pendingInteraction: _pendingInteraction, ...executionWithoutPending } = execution;
  return {
    ...executionWithoutPending,
    currentNodeId: target.id,
    completedNodeIds: [...completed],
    status: nextStatus,
    ...(waitingForHuman
      ? {
          pendingInteraction: {
            id: 'pending-' + execution.workflowId + '-' + String(execution.workflowVersion) + '-' + target.id,
            nodeId: target.id,
            reason: '等待人工完成“' + target.title + '”。',
            requestedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}

function advanceDeterministicJourney(
  definition: JourneyDefinition,
  execution: JourneyExecution,
  facts: JourneyFacts,
): JourneyExecution {
  const completed = new Set(execution.completedNodeIds);
  let currentNodeId = execution.currentNodeId;
  let status = execution.status;
  let pendingInteraction = execution.pendingInteraction;

  if (status === 'waiting') {
    return execution;
  }

  for (let guard = 0; guard < definition.nodes.length + 1; guard += 1) {
    const node = definition.nodes.find((item) => item.id === currentNodeId);
    if (!node) break;
    if (node.type === 'end') {
      status = 'completed';
      pendingInteraction = undefined;
      break;
    }
    if (node.type === 'stop') {
      status = 'stopped';
      pendingInteraction = undefined;
      break;
    }
    if (node.actor === 'human') {
      status = 'waiting';
      pendingInteraction = pendingInteraction ?? {
        id: 'pending-' + execution.workflowId + '-' + String(execution.workflowVersion) + '-' + node.id,
        nodeId: node.id,
        reason: '等待人工完成“' + node.title + '”。',
        requestedAt: new Date().toISOString(),
      };
      break;
    }
    if (node.completion !== 'deterministic' || !conditionPassed(node.completeWhen, facts)) break;

    const conditionalRoute = node.routes.find(
      (item) => item.condition && conditionPassed(item.condition, facts),
    );
    const route = conditionalRoute
      // 条件都没有命中时，任意第一个无条件出口都可以作为 fallback。
      // 不要求 outcome 必须叫 success，避免 DSL 隐藏一个额外的 outcome 规则。
      ?? node.routes.find((item) => !item.condition)
      ?? node.routes.find((item) => ['success', 'pass', 'done'].includes(item.outcome));

    // 只有真正走出当前节点才算完成；自环通常表示 retry/重新处理，不应把当前节点标成 completed。
    if (!route || route.target === node.id) break;

    completed.add(node.id);
    currentNodeId = route.target;
  }

  const { pendingInteraction: _pendingInteraction, ...executionWithoutPending } = execution;
  return {
    ...executionWithoutPending,
    currentNodeId,
    completedNodeIds: [...completed],
    status,
    ...(status === 'waiting' && pendingInteraction ? { pendingInteraction } : {}),
  };
}

function reachableFromCurrent(
  start: string,
  definition: JourneyDefinition,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = definition.nodes.find((item) => item.id === current);
    for (const route of node?.routes ?? []) queue.push(route.target);
  }
  return seen;
}

/**
 * 根据真实图关系计算 JourneyState。
 * execution 存在时优先使用它；deterministic 节点再根据 facts 自动推进。
 */
export function buildJourneyState(
  definition: JourneyDefinition,
  facts: JourneyFacts,
  execution?: JourneyExecution,
): JourneyState {
  const baseExecution = execution && execution.workflowId === definition.id
    ? execution
    : initialJourneyExecution(definition);

  const advanced = advanceDeterministicJourney(definition, baseExecution, facts);
  const completed = new Set(advanced.completedNodeIds);
  const visibleNodes = definition.nodes.filter(
    (node) => node.visible && node.type !== 'stop',
  );

  let displayCurrentId = advanced.currentNodeId;
  if (!visibleNodes.some((node) => node.id === displayCurrentId)) {
    const reachable = reachableFromCurrent(advanced.currentNodeId, definition);
    displayCurrentId = visibleNodes.find((node) => reachable.has(node.id))?.id
      ?? [...visibleNodes].reverse().find((node) => completed.has(node.id))?.id
      ?? visibleNodes.at(-1)?.id
      ?? advanced.currentNodeId;
  }

  const reachable = reachableFromCurrent(advanced.currentNodeId, definition);
  const stages = visibleNodes.map((node) => {
    const done = completed.has(node.id);
    const current = node.id === displayCurrentId && !done;
    const status: JourneyStatus = done
      ? 'completed'
      : current
        ? 'current'
        : reachable.has(node.id)
          ? 'future'
          : 'locked';

    return {
      id: node.id,
      title: node.title,
      objective: node.objective || node.title,
      status,
      nodeType: node.type,
      unlocked: status !== 'locked',
    };
  });

  return {
    workflowId: definition.id,
    currentNodeId: advanced.currentNodeId,
    completedNodeIds: [...completed],
    unlockedNodeIds: [...new Set([...completed, ...reachable])],
    stages,
    execution: advanced,
  };
}

/** 给 Agent 的当前节点和合法出口摘要。 */
export function describeJourneyCurrentNode(
  definition: JourneyDefinition,
  execution: JourneyExecution,
) {
  const node = definition.nodes.find((item) => item.id === execution.currentNodeId);
  if (!node) throw new Error('Workflow 当前节点不存在：' + execution.currentNodeId);

  return {
    nodeId: node.id,
    type: node.type,
    title: node.title,
    objective: node.objective || node.title,
    completion: node.completion,
    actor: node.actor,
    ...(node.completeWhen ? { completeWhen: node.completeWhen } : {}),
    outcomes: node.routes.map((route) => ({
      outcome: route.outcome,
      target: route.target,
      ...(route.condition ? { condition: route.condition } : {}),
    })),
  };
}

/** 编辑器和运行时共用的结构 schema（节点/边另行导出，供 journey-edit 等复用）。 */
export const JourneyRouteSchema = z.object({
  outcome: z.string().min(1),
  target: z.string().min(1),
  condition: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
}).strict();

export const JourneyNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['task', 'gate', 'review', 'end', 'stop']),
  title: z.string().min(1),
  objective: z.string().optional(),
  visible: z.boolean(),
  completion: z.enum(['deterministic', 'agent']),
  actor: z.enum(['agent', 'human', 'system']).default('agent'),
  completeWhen: z.string().optional(),
  tools: z.array(z.string()).optional(),
  requires: z.array(z.string()).optional(),
  produces: z.array(z.string()).optional(),
  routes: z.array(JourneyRouteSchema),
  line: z.number().int().positive().optional(),
}).strict();

export const JourneyDefinitionSchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  nodes: z.array(JourneyNodeSchema).min(1),
}).strict().transform((value) => value as JourneyDefinition);
