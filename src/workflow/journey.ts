/**
 * Legacy Modernization Journey：把 Data Analyst / Data Architect 的工作组织成一张可执行路线图。
 *
 * Markdown Workflow 只描述路线和出口；具体怎么查仍由 Skill + Tool 决定。
 * 参考 copilot-server-agent 的 @flow / @task / @gate / @end / @stop 设计，
 * 这里只实现本项目当前真正需要的轻量部分，不引入完整流程引擎。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export type JourneyNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';
export type JourneyStatus = 'completed' | 'current' | 'locked' | 'future';

export interface JourneyRoute {
  outcome: string;
  target: string;
  line: number;
}

export interface JourneyNode {
  id: string;
  type: JourneyNodeType;
  title: string;
  objective?: string;
  visible: boolean;
  completeWhen?: string;
  routes: JourneyRoute[];
  line: number;
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
  currentState: {
    datasets: number;
    lineageCoverage: number | null;
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

export interface JourneyState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: JourneyStage[];
}

/**
 * 解析 Markdown Workflow。
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
      completeWhen: current.attrs.completeWhen,
      routes: current.routes,
      line: current.line,
    });
    current = undefined;
  };

  const headingPattern = /^##\s+@(flow|task|gate|review|end|stop)\s+([A-Za-z0-9._:-]+)\s*$/;
  const routePattern = /^[-*]\s+([A-Za-z0-9._:-]+)\s*->\s*([A-Za-z0-9._:-]+)\s*$/;
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

  if (flowId && issues.length === 0 && startTarget) {
    return {
      definition: {
        id: flowId,
        start: startTarget,
        nodes: nodes.filter((node) => node.id !== 'start'),
      },
      issues,
    };
  }

  return { issues };
}

/** 从 skills/legacy-modernization/SKILL.md 加载主路线。 */
export async function loadModernizationJourney(): Promise<JourneyDefinition> {
  const skillPath = path.join(config.skillsDir, 'legacy-modernization', 'SKILL.md');
  const markdown = await fs.readFile(skillPath, 'utf8');
  const result = parseJourneyMarkdown(markdown);
  if (!result.definition || result.issues.length) {
    throw new Error(
      'Legacy Modernization workflow 定义无效：\n' + result.issues.join('\n'),
    );
  }
  return result.definition;
}

function conditionPassed(condition: string | undefined, facts: JourneyFacts): boolean {
  switch (condition) {
    case 'goal':
      return Boolean(facts.goal.trim());

    case 'current-state':
      return Boolean(facts.currentState);

    case 'data-truth':
      return Boolean(
        facts.currentState
        && facts.currentState.datasets > 0
        && facts.currentState.parseFailures === 0
        && (facts.currentState.lineageCoverage ?? 0) >= 0.8
        && (facts.currentState.semanticAssets > 0 || !facts.highGapKinds.includes('semantic')),
      );

    case 'investigation':
      return Boolean(
        facts.currentState
        && facts.unknowns.length <= 3
        && !facts.highGapKinds.some((kind) => ['discovery', 'lineage', 'semantic'].includes(kind)),
      );

    case 'current-state-ready':
      return Boolean(
        facts.currentState
        && !facts.highGapKinds.some((kind) => ['discovery', 'lineage', 'semantic'].includes(kind)),
      );

    case 'target':
      return facts.targetComponentCount > 0;

    case 'mapping':
      return facts.mappingCount > 0;

    case 'validation':
      return facts.blockingValidationTotal > 0
        && facts.blockingValidationReady >= facts.blockingValidationTotal;

    case 'cutover':
      return conditionPassed('validation', facts);

    default:
      return false;
  }
}

/**
 * 根据确定性状态计算当前关卡。
 *
 * Agent 可以建议下一步，但不能靠“我已经完成了”推进地图。
 * 只有 Investigation / discovery / modernization artifacts 真正变化，路线才推进。
 */
export function buildJourneyState(
  definition: JourneyDefinition,
  facts: JourneyFacts,
): JourneyState {
  const visibleNodes = definition.nodes.filter(
    (node) => node.visible && node.type !== 'stop',
  );

  const completedNodeIds = visibleNodes
    .filter((node) => conditionPassed(node.completeWhen, facts))
    .map((node) => node.id);

  const currentIndex = visibleNodes.findIndex(
    (node) => !completedNodeIds.includes(node.id),
  );

  const currentNodeId = currentIndex >= 0
    ? visibleNodes[currentIndex].id
    : visibleNodes.at(-1)?.id ?? definition.start;

  const unlockedNodeIds = visibleNodes
    .slice(
      0,
      Math.max(
        currentIndex + 2,
        completedNodeIds.length === visibleNodes.length ? visibleNodes.length : 1,
      ),
    )
    .map((node) => node.id);

  const stages = visibleNodes.map((node, index) => {
    const completed = completedNodeIds.includes(node.id);
    const current = node.id === currentNodeId;
    let status: JourneyStatus = 'locked';

    if (completed) status = 'completed';
    else if (current) status = 'current';
    else if (index <= currentIndex + 1) status = 'future';

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
    currentNodeId,
    completedNodeIds,
    unlockedNodeIds,
    stages,
  };
}
