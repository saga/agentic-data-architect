/**
 * Legacy Modernization Journey：把 Data Analyst / Data Architect 的工作组织成一张可执行路线图。
 *
 * 这里是 Workflow 的核心运行边界：Markdown 描述路线，应用代码提供事实，执行状态单独持久化。
 *
 * Markdown Workflow 只描述路线和出口；具体怎么查仍由 Skill + Tool 决定。
 * 参考 copilot-server-agent 的轻量 @flow / @task / @review / @end 设计，
 * 这里只实现本项目当前真正需要的轻量部分，不引入完整流程引擎。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { config } from '../config.js';
import type { WorkflowId } from '../investigation/schemas.js';
import { parseSkillManifest } from '../skills/catalog.js';
import {
  JourneyDefinitionSchema,
  JourneyNodeSchema,
  JourneyRouteSchema,
  JourneyExecutionSchema,
  JourneyRunEventSchema,
  JourneyStageSchema,
  type JourneyNode as SharedJourneyNode,
  type JourneyRoute as SharedJourneyRoute,
  type JourneyExecution as SharedJourneyExecution,
  type JourneyRunEvent as SharedJourneyRunEvent,
} from '../api/contracts.js';
import { evaluateDerivedState } from './derived-state.js';

export { JourneyDefinitionSchema, JourneyNodeSchema, JourneyRouteSchema, JourneyExecutionSchema, JourneyRunEventSchema } from '../api/contracts.js';

export type JourneyNodeType = 'task' | 'review' | 'end';
export type JourneyActor = 'agent' | 'human';
export type JourneyStatus = 'completed' | 'current' | 'locked' | 'future';

export interface ParsedJourney {
  definition?: JourneyDefinition;
  issues: string[];
}

/**
 * 当前 Workflow 自动推进时读取的事实快照。
 *
 * 这些字段属于应用状态，而不是 Markdown DSL。Workflow 只保存 completeWhen 的名字，
 * 这里才决定这个名字如何映射到真实事实。这样增加业务事实时，不需要继续增加 DSL 字段。
 */
export interface JourneyFacts {
  /** 用户明确给出的本次调查目标；为空时通常不能自动完成 intake。 */
  goal: string;
  /** Scope Gate 是否已经确认 Goal / Scope / Systems。 */
  scopeReady?: boolean;
  /** 当前 Investigation 已保存的 Finding 数量，是原始事实，不是 completion signal。 */
  findingCount?: number;
  currentState: {
    datasets: number;
    semanticAssets: number;
    parseFailures: number;
    connectedDatasets?: number;
    sqlFiles?: number;
    sqlParsedStatements?: number;
  } | null;
  /** 当前仍未解决的未知项，主要供 Agent 和 UI 导航使用。 */
  unknowns: string[];
  /** 高严重度缺口类型，用来阻止关键调查阶段过早通过。 */
  highGapKinds: string[];
  targetStatus?: string;
  targetComponentCount: number;
  mappingStatuses: string[];
  validationStatuses: Array<{ status: string; blocking: boolean }>;
  estateColumnCount?: number;
  sourceOfTruthCandidateCount?: number;
  lineageEdgeCount?: number;
  assessmentPlanExists?: boolean;
  assessmentFindingCount?: number;
  assessmentRecommendationCount?: number;
  assessmentRoadmapCount?: number;
}

export type JourneyRoute = SharedJourneyRoute;
export type JourneyNode = SharedJourneyNode;
export type JourneyDefinition = z.infer<typeof JourneyDefinitionSchema>;
export type JourneyStage = z.infer<typeof JourneyStageSchema>;
export type JourneyPendingInteraction = z.infer<typeof JourneyExecutionSchema>['pendingInteraction'];
export type JourneyRunEvent = SharedJourneyRunEvent;
export type JourneyRunEventType = SharedJourneyRunEvent['type'];
export type JourneyExecution = SharedJourneyExecution;

export interface JourneyState {
  workflowId: string;
  stages: JourneyStage[];
  execution: JourneyExecution;
}

/**
 * 解析 Markdown Workflow。
 *
 * 支持 Markdown 列表中的 "- success -> next-task"，
 * 以及 Workflow 顶部的 "start -> first-task"。
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
  let inFence = false;
  let current: {
    id: string;
    type: JourneyNodeType;
    title: string;
    attrs: Record<string, string>;
    attrsClosed: boolean;
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
      actor: current.attrs.actor === 'human'
        ? 'human'
        : current.type === 'review'
          ? 'human'
          : 'agent',
      completeWhen: current.attrs.completeWhen,
      routes: current.routes,
      line: current.line,
    });
    current = undefined;
  };

  const headingPattern = /^##\s+@(flow|task|review|end)\s+([A-Za-z0-9._:-]+)\s*$/;
  const routePattern = /^(?:[-*]\s+)?([A-Za-z0-9._:-]+)\s*->\s*([A-Za-z0-9._:-]+)\s*$/;
  const attrPattern = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index].trim();
    if (!raw) continue;

    if (raw.startsWith('```') || raw.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^(?:##\s+)?@(gate|stop)\b/i.test(raw)) {
      issues.push('不再支持 @gate / @stop；Workflow Gate 必须由服务端确定性逻辑实现。第 ' + lineNumber + ' 行无效。');
      continue;
    }

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
          attrsClosed: false,
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

    if (raw.includes('->') && !route) {
      issues.push('Workflow 不支持带条件或其它扩展语法的连线，只能使用 outcome -> target。第 ' + lineNumber + ' 行无效。');
      continue;
    }

    if (route) {
      current.routes.push({
        outcome: route[1].toLowerCase(),
        target: route[2],
        line: lineNumber,
      });
      continue;
    }

    const attr = attrPattern.exec(raw);
    if (attr && current.routes.length === 0 && !current.attrsClosed) {
      if (!['title', 'objective', 'actor', 'completeWhen'].includes(attr[1])) {
        issues.push(current.id + ' 使用了不支持的 Workflow 字段：' + attr[1] + '。第 ' + lineNumber + ' 行无效。');
      } else {
        current.attrs[attr[1]] = attr[2];
      }
      continue;
    }

    if (!attr && current.routes.length === 0 && !raw.startsWith('#')) {
      current.attrsClosed = true;
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
    throw new Error('工作方式 ' + workflowId + ' 对应的技能名称不一致：' + manifest.name);
  }
  if (manifest.metadata.kind !== 'workflow') {
    throw new Error('技能 ' + workflowId + ' 的类型不能作为工作方式加载。');
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
  'scope-ready',
  'current-state',
  'data-truth',
  'investigation',
  'current-state-ready',
  'target',
  'mapping',
  'validation',
  'cutover',
  'current-data-architecture',
  'current-data-architecture-ready',
  'assessment-current-state',
  'assessment-findings',
  'assessment-recommendation',
  'assessment-roadmap',
] as const;

/** 对外暴露 Workflow 的确定性完成判断；Agent 的 success 只能在这里返回 true 时生效。 */
export function isJourneyCompletionConditionSatisfied(
  condition: string | undefined,
  facts: JourneyFacts,
): boolean {
  return conditionPassed(condition, facts);
}

function conditionPassed(condition: string | undefined, facts: JourneyFacts): boolean {
  const coverage = facts.currentState
    ? {
        sqlFiles: facts.currentState.sqlFiles ?? 0,
        sqlParsedStatements: facts.currentState.sqlParsedStatements ?? 0,
        sqlParseFailures: facts.currentState.parseFailures,
        datasets: facts.currentState.datasets,
        connectedDatasets: facts.currentState.connectedDatasets ?? 0,
        semanticAssets: facts.currentState.semanticAssets,
      }
    : null;
  const derived = evaluateDerivedState({
    goal: facts.goal,
    currentState: coverage ? { coverage } : null,
    estateColumnCount: facts.estateColumnCount ?? 0,
    sourceOfTruthCandidateCount: facts.sourceOfTruthCandidateCount ?? 0,
    lineageEdgeCount: facts.lineageEdgeCount ?? 0,
    findingsCount: facts.findingCount ?? 0,
    scopeReady: facts.scopeReady === true,
    highGapKinds: facts.highGapKinds,
    modernization: facts.targetComponentCount > 0 || facts.mappingStatuses.length || facts.validationStatuses.length
      ? {
          targetStatus: facts.targetStatus ?? 'draft',
          targetComponentCount: facts.targetComponentCount,
          mappingStatuses: facts.mappingStatuses,
          validationStatuses: facts.validationStatuses,
        }
      : null,
    assessment: facts.assessmentPlanExists !== undefined
      ? {
          exists: facts.assessmentPlanExists,
          findingsCount: facts.assessmentFindingCount ?? 0,
          recommendationCount: facts.assessmentRecommendationCount ?? 0,
          roadmapCount: facts.assessmentRoadmapCount ?? 0,
        }
      : null,
  });

  switch (condition) {
    case 'goal': return derived.goalReady;
    case 'scope-ready': return derived.scopeReady;
    case 'current-state': return derived.currentStateAvailable;
    case 'data-truth': return derived.dataTruthReady;
    case 'investigation': return derived.investigationReady;
    case 'current-state-ready': return derived.currentStateReady;
    case 'target': return derived.targetArchitectureReady;
    case 'mapping': return derived.mappingReady;
    case 'validation': return derived.validationReady;
    case 'current-data-architecture': return derived.currentStateAvailable;
    case 'current-data-architecture-ready': return derived.currentDataArchitectureReady;
    case 'assessment-current-state': return derived.assessmentCurrentStateReady;
    case 'assessment-findings': return derived.assessmentFindingsReady;
    case 'assessment-recommendation': return derived.assessmentRecommendationReady;
    case 'assessment-roadmap': return derived.assessmentRoadmapReady;
    case 'cutover': return derived.validationReady;
    default: return false;
  }
}

/**
 * 校验 Workflow 图本身，不校验业务结果。
 *
 * 保存前必须通过这里，避免出现三类最常见的问题：
 * - 连到了不存在的节点；
 * - 从 start 根本走不到某一步；
 * - 某个回路只能无限重试、永远到不了 @end。
 *
 * retry / rollback 可以是正常的回边，只要这张图仍然存在到 @end 的有效路径。
 */
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

    if (node.actor !== 'agent' && node.actor !== 'human') {
      issues.push(node.id + ' 使用了未知 actor：' + node.actor);
    }
    if (node.completeWhen && !(KNOWN_COMPLETION_CONDITIONS as readonly string[]).includes(node.completeWhen)) {
      issues.push(node.id + ' 使用了未知 completeWhen：' + node.completeWhen);
    }
    if (node.type === 'end' && node.completeWhen) {
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
      const normalizedOutcome = route.outcome.toLowerCase();
      if (outcomes.has(normalizedOutcome)) {
        issues.push(node.id + ' 重复使用 outcome：' + route.outcome);
      }
      outcomes.add(normalizedOutcome);
      outgoing.set(node.id, [...(outgoing.get(node.id) ?? []), route]);
      incoming.set(route.target, [...(incoming.get(route.target) ?? []), node.id]);
    }

    if (node.type === 'end') {
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
    .filter((node) => node.type === 'end')
    .map((node) => node.id);
  if (!terminals.length) issues.push('Workflow 至少需要一个 @end 终点。');

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
      issues.push('节点无法沿任何路径到达 @end：' + node.id);
    }
  }

  return [...new Set(issues)];
}

/**
 * 创建一个与 Workflow version 绑定的执行快照。
 *
 * Execution 只记录“现在在哪一步”和“哪些步骤已经走过”，不保存 Agent 对话、
 * Tool 状态或 X6 对象。人工步骤进入 waiting，并留下 pendingInteraction 供 UI 展示。
 */
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

/**
 * 从当前节点沿已声明的 outcome 推进。
 *
 * 调用方只能选择当前节点已经声明的出口，不能直接指定 target。
 * 这保证 Agent 返回的 Workflow 控制信息只能落在服务端已经定义的图结构里。
 */
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
  if (!node) throw new Error('当前工作步骤不存在：' + nodeId);

  const route = node.routes.find(
    (item) => item.outcome.toLowerCase() === outcome.toLowerCase(),
  );
  if (!route) {
    throw new Error(
      'Workflow 节点 ' + nodeId + ' 没有 outcome=' + outcome + ' 的出口。',
    );
  }

  const target = definition.nodes.find((item) => item.id === route.target);
  if (!target) throw new Error('下一步指向的工作步骤不存在：' + route.target);

  const completed = new Set(execution.completedNodeIds);
  if (target.id !== nodeId) completed.add(nodeId);

  const waitingForHuman = target.actor === 'human' && target.type !== 'end';
  const nextStatus: JourneyExecution['status'] = target.type === 'end'
    ? 'completed'
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

/**
 * 根据当前 facts 连续推进可以自动完成的节点。
 *
 * 只从 execution.currentNodeId 开始，不扫描整个图，也不让 Agent 自己决定 deterministic
 * 节点是否完成。每次只走当前节点的第一个 route；若没有 route、条件不满足或形成自环，就停在原地。
 * 额外的 guard 防止错误 Workflow 因回路无限执行。
 */
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
    if (!node.completeWhen || !conditionPassed(node.completeWhen, facts)) break;

    // completeWhen 满足后，按 DSL 中写下的第一个出口继续。
    const route = node.routes[0];

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
  const visibleNodes = definition.nodes;

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
    };
  });

  return {
    workflowId: definition.id,
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
  if (!node) throw new Error('当前工作步骤不存在：' + execution.currentNodeId);

  return {
    nodeId: node.id,
    type: node.type,
    title: node.title,
    objective: node.objective || node.title,
     actor: node.actor,
    ...(node.completeWhen ? { completeWhen: node.completeWhen } : {}),
    outcomes: node.routes.map((route) => ({
      outcome: route.outcome,
      target: route.target,
    })),
  };
}

