/**
 * 工作地图编辑器的服务端存储边界。
 *
 * 内置 Skill 只提供初始路线；用户修改后直接保存到 Investigation workspace。
 * React Flow 的坐标只属于画布布局，不进入 Workflow 语义。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { appendAuditEvent } from '../investigation/control.js';
import {
  ensureWorkspace,
  loadWorkspaceContext,
  writeJsonAtomic,
  workspaceRoot,
  withWorkspaceContextLock,
} from '../investigation/workspace.js';
import { loadLatestSnapshot } from '../investigation/store.js';
import type { WorkflowId } from '../investigation/schemas.js';
import type { DiscoverySnapshot } from './discover.js';
import {
  applyJourneyTransition,
  buildJourneyState,
  describeJourneyCurrentNode,
  initialJourneyExecution,
  JourneyDefinitionSchema,
  loadWorkflowJourney,
  parseJourneyMarkdown,
  validateJourneyDefinition,
  type JourneyDefinition,
  type JourneyExecution,
  type JourneyFacts,
  type JourneyRunEvent,
  type JourneyState,
} from './journey.js';
import {
  analyzeJourneyWorkflow,
  type JourneyAnalysisIssue,
} from './journey-edit.js';

const JOURNEY_DIR = 'workflow';
const ACTIVE_FILE = 'journey.md';
const META_FILE = 'journey-meta.json';
const LAYOUT_FILE = 'journey-layout.json';
const EXECUTION_FILE = 'journey-execution.json';
const EVENTS_FILE = 'journey-run-events.jsonl';

export const JourneyLayoutNodeSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

export const JourneyLayoutSchema = z.object({
  version: z.literal(1),
  nodes: z.record(z.string(), JourneyLayoutNodeSchema),
  /** 当前使用的自动布局算法；旧 layout 可以没有这个字段。 */
  engine: z.enum(['elk', 'elk-v2']).optional(),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  }).optional(),
}).strict();

export type JourneyLayout = z.infer<typeof JourneyLayoutSchema>;

export const JourneyEditBodySchema = z.object({
  definition: JourneyDefinitionSchema,
  layout: JourneyLayoutSchema,
}).strict();

const JourneyMetaSchema = z.object({
  schemaVersion: z.literal(1),
  baseWorkflowId: z.string().min(1),
  version: z.number().int().nonnegative(),
}).strict();

type JourneyMeta = z.infer<typeof JourneyMetaSchema>;

export interface JourneySnapshot {
  workflowId: WorkflowId;
  source: 'base' | 'custom';
  baseWorkflowId: WorkflowId;
  version: number;
  definition: JourneyDefinition;
  layout: JourneyLayout;
  execution: JourneyExecution;
  state: JourneyState;
  analysis: JourneyAnalysisIssue[];
  events: JourneyRunEvent[];
}

function journeyDir(name: string): string {
  return path.join(workspaceRoot(name), JOURNEY_DIR);
}

function journeyFile(name: string, file: string): string {
  return path.join(journeyDir(name), file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/**
 * 运行事件用 JSONL 追加保存：简单、可检查，不让 execution.json 无限增长。
 */
export async function appendJourneyRunEvent(name: string, event: JourneyRunEvent): Promise<void> {
  await fs.mkdir(journeyDir(name), { recursive: true });
  await fs.appendFile(journeyFile(name, EVENTS_FILE), JSON.stringify(event) + '\n', 'utf8');
}

/** 只读取最近的事件，避免快照随着运行历史无限增长。 */
export async function loadJourneyRunEvents(name: string, limit = 80): Promise<JourneyRunEvent[]> {
  const raw = await readTextOrNull(journeyFile(name, EVENTS_FILE));
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as JourneyRunEvent];
    } catch {
      return [];
    }
  });
}


/** 按图深度给新 Workflow 一个稳定初始布局；用户拖动后的坐标另存。 */
export function defaultJourneyLayout(definition: JourneyDefinition): JourneyLayout {
  const depth = new Map<string, number>([[definition.start, 0]]);
  const queue = [definition.start];
  const outgoing = new Map<string, string[]>();

  for (const node of definition.nodes) {
    for (const route of node.routes) {
      outgoing.set(node.id, [...(outgoing.get(node.id) ?? []), route.target]);
    }
  }

  while (queue.length) {
    const current = queue.shift() as string;
    const currentDepth = depth.get(current) ?? 0;
    for (const target of outgoing.get(current) ?? []) {
      if (depth.has(target)) continue;
      depth.set(target, currentDepth + 1);
      queue.push(target);
    }
  }

  const levels = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const level = depth.get(node.id) ?? 0;
    levels.set(level, [...(levels.get(level) ?? []), node.id]);
  }

  const nodes: JourneyLayout['nodes'] = {};
  for (const [level, ids] of levels) {
    ids.forEach((id, index) => {
      nodes[id] = {
        x: level * 310,
        y: (index - (ids.length - 1) / 2) * 175,
      };
    });
  }

  return { version: 1, nodes };
}

/** 序列化成可人工阅读、可重新 parse 的 Workflow Markdown。 */
export function serializeJourneyMarkdown(definitionInput: JourneyDefinition): string {
  const definition = JourneyDefinitionSchema.parse(definitionInput);
  const lines = [
    '# Generated Investigation Workflow',
    '',
    '## @flow ' + definition.id,
    '',
    'start -> ' + definition.start,
    '',
  ];

  for (const node of definition.nodes) {
    lines.push('## @' + node.type + ' ' + node.id);
    lines.push('title: ' + node.title);
    if (node.objective) lines.push('objective: ' + node.objective);
    lines.push('visible: ' + String(node.visible));
    lines.push('completion: ' + node.completion);
    lines.push('actor: ' + node.actor);
    if (node.completeWhen) lines.push('completeWhen: ' + node.completeWhen);
    if (node.tools?.length) lines.push('tools: ' + node.tools.join(', '));
    if (node.requires?.length) lines.push('requires: ' + node.requires.join(', '));
    if (node.produces?.length) lines.push('produces: ' + node.produces.join(', '));
    for (const route of node.routes) {
      lines.push(
        '- ' + route.outcome + ' -> ' + route.target
        + (route.condition ? ' if ' + route.condition : ''),
      );
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function normalizeExecution(
  definition: JourneyDefinition,
  version: number,
  execution: JourneyExecution | null,
): JourneyExecution {
  if (
    !execution
    || execution.workflowId !== definition.id
    || execution.workflowVersion !== version
    || !definition.nodes.some((node) => node.id === execution.currentNodeId)
  ) {
    return initialJourneyExecution(definition, version);
  }

  const currentNode = definition.nodes.find((node) => node.id === execution.currentNodeId);
  const needsHuman = currentNode?.actor === 'human' && currentNode.type !== 'end' && currentNode.type !== 'stop';
  const runId = execution.runId || definition.id + '-v' + String(version);
  if (needsHuman && execution.status !== 'waiting') {
    return {
      ...execution,
      workflowVersion: version,
      runId,
      status: 'waiting',
      pendingInteraction: {
        id: 'pending-' + runId + '-' + currentNode.id,
        nodeId: currentNode.id,
        reason: '等待人工完成“' + currentNode.title + '”。',
        requestedAt: new Date().toISOString(),
      },
    };
  }
  return {
    ...execution,
    workflowVersion: version,
    runId,
  };
}

async function loadCustomActive(
  name: string,
  workflowId: WorkflowId,
): Promise<{ definition: JourneyDefinition; layout: JourneyLayout; version: number } | null> {
  const markdown = await readTextOrNull(journeyFile(name, ACTIVE_FILE));
  if (markdown === null) return null;

  const meta = JourneyMetaSchema.safeParse(await readJson<unknown>(journeyFile(name, META_FILE)));
  if (!meta.success || meta.data.baseWorkflowId !== workflowId) return null;

  const parsed = parseJourneyMarkdown(markdown);
  if (!parsed.definition || parsed.issues.length) {
    throw new Error(
      'Investigation 自定义 Workflow 无效：\n' + parsed.issues.join('\n'),
    );
  }
  if (parsed.definition.id !== workflowId) {
    throw new Error('自定义 Workflow id 必须与当前工作方式一致：' + workflowId);
  }

  const rawLayout = await readJson<unknown>(journeyFile(name, LAYOUT_FILE));
  const parsedLayout = JourneyLayoutSchema.safeParse(rawLayout);

  return {
    definition: parsed.definition,
    layout: parsedLayout.success
      ? parsedLayout.data
      : defaultJourneyLayout(parsed.definition),
    version: meta.data.version,
  };
}

/** Journey 的 deterministic facts 不发起模型调用，只读取已有 workspace 状态。 */
async function buildJourneyFacts(name: string): Promise<JourneyFacts> {
  const context = await loadWorkspaceContext(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);

  return {
    goal: context.goal || context.userPrompt,
    currentState: snapshot?.currentState
      ? {
          datasets: snapshot.currentState.coverage.datasets,
          lineageCoverage: snapshot.currentState.coverage.datasetLineageCoverage,
          semanticAssets: snapshot.currentState.coverage.semanticAssets,
          parseFailures: snapshot.currentState.coverage.sqlParseFailures,
        }
      : null,
    unknowns: context.unknowns,
    highGapKinds: [],
    targetComponentCount: 0,
    mappingCount: 0,
    blockingValidationReady: 0,
    blockingValidationTotal: 0,
  };
}

/** 当前 Investigation 的 active Workflow；没有 custom 时使用内置 Skill。 */
export async function loadActiveJourney(
  name: string,
  workflowId: WorkflowId,
): Promise<{
  source: 'base' | 'custom';
  baseWorkflowId: WorkflowId;
  version: number;
  definition: JourneyDefinition;
  layout: JourneyLayout;
}> {
  const custom = await loadCustomActive(name, workflowId);
  if (custom) {
    return {
      source: 'custom',
      baseWorkflowId: workflowId,
      version: custom.version,
      definition: custom.definition,
      layout: custom.layout,
    };
  }

  const definition = await loadWorkflowJourney(workflowId);
  return {
    source: 'base',
    baseWorkflowId: workflowId,
    version: 0,
    definition,
    layout: defaultJourneyLayout(definition),
  };
}

/** 读取和当前 Workflow version 绑定的执行状态。 */
export async function loadJourneyExecution(
  name: string,
  definition: JourneyDefinition,
  version: number,
): Promise<JourneyExecution> {
  const raw = await readJson<unknown>(journeyFile(name, EXECUTION_FILE));
  const parsed = z.object({
    workflowId: z.string(),
    workflowVersion: z.number().int().nonnegative(),
    runId: z.string().optional(),
    currentNodeId: z.string(),
    completedNodeIds: z.array(z.string()),
    status: z.enum(['active', 'waiting', 'completed', 'stopped']),
    pendingInteraction: z.object({
      id: z.string(),
      nodeId: z.string(),
      reason: z.string(),
      requestedAt: z.string().datetime(),
    }).optional(),
  }).safeParse(raw);

  return normalizeExecution(definition, version, parsed.success ? parsed.data : null);
}

/** 编辑器 / 右侧 Journey 共用的完整快照。 */
export async function getJourneySnapshot(
  name: string,
  workflowId: WorkflowId,
): Promise<JourneySnapshot> {
  const active = await loadActiveJourney(name, workflowId);
  const execution = await loadJourneyExecution(name, active.definition, active.version);
  const facts = await buildJourneyFacts(name);
  const state = buildJourneyState(active.definition, facts, execution);
  const analysis = analyzeJourneyWorkflow(active.definition);
  const events = await loadJourneyRunEvents(name);

  // Deterministic completion may move the current node without an Agent transition.
  // Persist that state so the next turn cannot observe an older current node.
  if (
    state.execution.currentNodeId !== execution.currentNodeId
    || state.execution.status !== execution.status
    || state.execution.completedNodeIds.length !== execution.completedNodeIds.length
    || state.execution.completedNodeIds.some((id) => !execution.completedNodeIds.includes(id))
  ) {
    await withWorkspaceContextLock(name, async () => {
      const latest = await loadJourneyExecution(name, active.definition, active.version);
      if (
        latest.currentNodeId === execution.currentNodeId
        && latest.workflowVersion === execution.workflowVersion
      ) {
        await fs.mkdir(journeyDir(name), { recursive: true });
        await writeJsonAtomic(journeyFile(name, EXECUTION_FILE), state.execution);
      }
    });
  }

  return {
    workflowId,
    source: active.source,
    baseWorkflowId: active.baseWorkflowId,
    version: active.version,
    definition: active.definition,
    layout: active.layout,
    execution: state.execution,
    state,
    analysis,
    events,
  };
}

/** 图验证入口；同时检查每个节点是否有画布位置。 */
export function validateJourneyEdit(
  definitionInput: JourneyDefinition,
  layoutInput: JourneyLayout,
): { issues: string[]; warnings: string[] } {
  const definition = JourneyDefinitionSchema.parse(definitionInput);
  const layout = JourneyLayoutSchema.parse(layoutInput);
  const issues = validateJourneyDefinition(definition);
  const warnings = analyzeJourneyWorkflow(definition).map((item) => item.message);

  for (const node of definition.nodes) {
    if (!layout.nodes[node.id]) issues.push('节点缺少画布位置：' + node.id);
  }

  return {
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
  };
}

/** 保存一张工作地图；服务端重新验证，不能绕过结构检查。 */
export async function saveJourneyDefinition(
  name: string,
  workflowId: WorkflowId,
  definitionInput: JourneyDefinition,
  layoutInput: JourneyLayout,
): Promise<{ version: number; snapshot: JourneySnapshot }> {
  const definition = JourneyDefinitionSchema.parse(definitionInput);
  const layout = JourneyLayoutSchema.parse(layoutInput);

  if (definition.id !== workflowId) {
    throw new Error('Workflow id 不能修改为另一个工作方式。');
  }

  const validation = validateJourneyEdit(definition, layout);
  if (validation.issues.length) {
    throw new Error('Workflow 验证失败：\\n' + validation.issues.join('\\n'));
  }

  const version = await withWorkspaceContextLock(name, async () => {
    await ensureWorkspace(name);
    const active = await loadActiveJourney(name, workflowId);
    const nextVersion = active.source === 'custom' ? active.version + 1 : 1;
    const oldExecution = await loadJourneyExecution(
      name,
      active.definition,
      active.version,
    );
    const newNodeIds = new Set(definition.nodes.map((node) => node.id));
    const preservedCompleted = oldExecution.completedNodeIds.filter((id) => newNodeIds.has(id));
    const preservedCurrent = newNodeIds.has(oldExecution.currentNodeId)
      ? oldExecution.currentNodeId
      : definition.start;
    const preservedNode = definition.nodes.find((node) => node.id === preservedCurrent);
    const preservedTargetNode = definition.nodes.find((node) => node.id === preservedCurrent);
    const migratedExecution: JourneyExecution = {
      ...oldExecution,
      workflowId: definition.id,
      workflowVersion: nextVersion,
      runId: definition.id + '-v' + String(nextVersion),
      currentNodeId: preservedCurrent,
      completedNodeIds: preservedCompleted,
      status: preservedNode?.type === 'end'
        ? 'completed'
        : preservedNode?.type === 'stop'
          ? 'stopped'
          : preservedTargetNode?.actor === 'human'
            ? 'waiting'
            : 'active',
      ...(preservedTargetNode?.actor === 'human'
        ? {
            pendingInteraction: {
              id: 'pending-' + definition.id + '-' + String(nextVersion),
              nodeId: preservedTargetNode.id,
              reason: '等待人工完成“' + preservedTargetNode.title + '”。',
              requestedAt: new Date().toISOString(),
            },
          }
        : { pendingInteraction: undefined }),
    };

    await fs.mkdir(journeyDir(name), { recursive: true });
    await fs.writeFile(
      journeyFile(name, ACTIVE_FILE),
      serializeJourneyMarkdown(definition),
      'utf8',
    );
    await writeJsonAtomic(journeyFile(name, META_FILE), {
      schemaVersion: 1,
      baseWorkflowId: workflowId,
      version: nextVersion,
    } satisfies JourneyMeta);
    await writeJsonAtomic(journeyFile(name, LAYOUT_FILE), layout);
    await writeJsonAtomic(
      journeyFile(name, EXECUTION_FILE),
      migratedExecution,
    );

    // Workflow 版本变化后，普通调查 Copilot Session 不能继续携带旧 Workflow 上下文。
    const current = await loadWorkspaceContext(name);
    const nextContext = { ...current };
    delete nextContext.copilotSessionId;
    delete nextContext.copilotConfigurationVersion;
    await writeJsonAtomic(
      path.join(workspaceRoot(name), 'context.json'),
      {
        ...nextContext,
        updatedAt: new Date().toISOString(),
      },
    );

    return nextVersion;
  });

  await appendAuditEvent(name, {
    actor: 'user',
    action: 'workflow.saved',
    summary: 'Saved a validated Investigation Workflow version.',
    details: {
      workflowId,
      version,
      nodeCount: definition.nodes.length,
      edgeCount: definition.nodes.reduce((sum, node) => sum + node.routes.length, 0),
    },
  });

  return {
    version,
    snapshot: await getJourneySnapshot(name, workflowId),
  };
}

/** 删除 Investigation 自定义 Workflow，恢复内置 Skill，并重新开始执行。 */
export async function resetJourneyCustomization(
  name: string,
  workflowId: WorkflowId,
): Promise<JourneySnapshot> {
  await withWorkspaceContextLock(name, async () => {
    // Workflow 定义可以重置，但运行历史属于审计/诊断信息，不随 reset 丢失。
    const events = await readTextOrNull(journeyFile(name, EVENTS_FILE));
    await fs.rm(journeyDir(name), { recursive: true, force: true });
    await fs.mkdir(journeyDir(name), { recursive: true });
    if (events) await fs.writeFile(journeyFile(name, EVENTS_FILE), events, 'utf8');
    const current = await loadWorkspaceContext(name);
    const nextContext = { ...current };
    delete nextContext.copilotSessionId;
    delete nextContext.copilotConfigurationVersion;
    await writeJsonAtomic(
      path.join(workspaceRoot(name), 'context.json'),
      {
        ...nextContext,
        updatedAt: new Date().toISOString(),
      },
    );
  });

  await appendAuditEvent(name, {
    actor: 'user',
    action: 'workflow.reset',
    summary: 'Reset Investigation Workflow to the built-in Skill definition.',
    details: { workflowId },
  });

  return getJourneySnapshot(name, workflowId);
}

/** 从 Agent 严格 JSON 中提取 workflow transition。 */
function extractWorkflowTransition(
  raw: string,
): { nodeId: string; outcome: string } | null {
  let data: unknown;

  try {
    const fenced = raw.match(new RegExp('\\x60{3}(?:json)?\\s*([\\s\\S]*?)\\x60{3}'));
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const jsonText = fenced?.[1]?.trim()
      ?? (start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const workflow = data && typeof data === 'object'
    ? (data as Record<string, unknown>).workflow
    : null;

  if (!workflow || typeof workflow !== 'object') return null;

  const nodeId = (workflow as Record<string, unknown>).nodeId;
  const outcome = (workflow as Record<string, unknown>).outcome;
  return typeof nodeId === 'string' && typeof outcome === 'string' && Boolean(nodeId) && Boolean(outcome)
    ? { nodeId, outcome }
    : null;
}

/**
 * transition 成功后记录最小运行事件；详细 trace 仍交给 Agent runtime / OTel。
 */
async function appendJourneyTransitionEvents(
  name: string,
  execution: JourneyExecution,
  nodeId: string,
  outcome: string,
  next: JourneyExecution,
): Promise<void> {
  const now = new Date().toISOString();
  const currentEvent: JourneyRunEvent = {
    id: crypto.randomUUID(),
    runId: execution.runId,
    workflowId: execution.workflowId,
    workflowVersion: execution.workflowVersion,
    type: 'node-completed',
    timestamp: now,
    nodeId,
    outcome,
    data: { nextNodeId: next.currentNodeId },
  };
  await appendJourneyRunEvent(name, currentEvent);

  if (next.status === 'waiting' && next.pendingInteraction) {
    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: next.runId,
      workflowId: next.workflowId,
      workflowVersion: next.workflowVersion,
      type: 'node-waiting',
      timestamp: new Date().toISOString(),
      nodeId: next.pendingInteraction.nodeId,
      data: next.pendingInteraction,
    });
  } else if (next.status === 'completed') {
    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: next.runId,
      workflowId: next.workflowId,
      workflowVersion: next.workflowVersion,
      type: 'workflow-completed',
      timestamp: new Date().toISOString(),
      nodeId: next.currentNodeId,
    });
  } else if (next.status === 'stopped') {
    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: next.runId,
      workflowId: next.workflowId,
      workflowVersion: next.workflowVersion,
      type: 'workflow-stopped',
      timestamp: new Date().toISOString(),
      nodeId: next.currentNodeId,
    });
  }
}

/** 将 Agent 返回的合法 outcome 写入 durable Workflow execution。 */
export async function applyAgentWorkflowTransition(
  name: string,
  workflowId: WorkflowId | null,
  rawAnswer: string,
): Promise<{ applied: boolean; error?: string; execution?: JourneyExecution }> {
  if (!workflowId) return { applied: false };

  const transition = extractWorkflowTransition(rawAnswer);
  if (!transition) return { applied: false };

  try {
    const active = await loadActiveJourney(name, workflowId);
    const execution = await loadJourneyExecution(
      name,
      active.definition,
      active.version,
    );
    const currentNode = active.definition.nodes.find((node) => node.id === execution.currentNodeId);
    if (execution.status === 'waiting' || currentNode?.actor === 'human') {
      throw new Error('当前 Workflow 正在等待人工处理，Agent 不能替代人工推进。');
    }
    const next = applyJourneyTransition(
      active.definition,
      execution,
      transition.nodeId,
      transition.outcome,
    );

    await withWorkspaceContextLock(name, async () => {
      const latestActive = await loadActiveJourney(name, workflowId);
      if (
        latestActive.source !== active.source
        || latestActive.version !== active.version
      ) {
        throw new Error('Workflow 在 Agent 执行期间发生变化，本次 transition 不再适用。');
      }

      const latest = await loadJourneyExecution(
        name,
        latestActive.definition,
        latestActive.version,
      );

      if (
        latest.currentNodeId !== execution.currentNodeId
        || latest.workflowVersion !== execution.workflowVersion
      ) {
        throw new Error('Workflow 在 Agent 执行期间发生变化，本次 transition 不再适用。');
      }

      await fs.mkdir(journeyDir(name), { recursive: true });
      await writeJsonAtomic(journeyFile(name, EXECUTION_FILE), next);
    });

    await appendJourneyTransitionEvents(
      name,
      execution,
      transition.nodeId,
      transition.outcome,
      next,
    );

    await appendAuditEvent(name, {
      actor: 'system',
      action: 'workflow.transition',
      summary: 'Applied Agent-selected Workflow outcome.',
      details: {
        workflowId,
        workflowVersion: active.version,
        nodeId: transition.nodeId,
        outcome: transition.outcome,
        target: next.currentNodeId,
      },
    });

    return { applied: true, execution: next };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: workflowId + '-rejected',
      workflowId,
      workflowVersion: 0,
      type: 'transition-rejected',
      timestamp: new Date().toISOString(),
      nodeId: transition.nodeId,
      outcome: transition.outcome,
      error: message,
    });

    await appendAuditEvent(name, {
      actor: 'system',
      action: 'workflow.transition.rejected',
      summary: 'Rejected invalid Agent Workflow outcome.',
      details: {
        workflowId,
        nodeId: transition.nodeId,
        outcome: transition.outcome,
        error: message,
      },
    });

    return { applied: false, error: message };
  }
}

/** 人工推进 waiting 节点；沿用同一条 transition / version 检查路径。 */
export async function applyHumanWorkflowTransition(
  name: string,
  workflowId: WorkflowId,
  nodeId: string,
  outcome: string,
): Promise<{ applied: boolean; error?: string; execution?: JourneyExecution }> {
  try {
    const active = await loadActiveJourney(name, workflowId);
    const execution = await loadJourneyExecution(name, active.definition, active.version);
    if (execution.status !== 'waiting') {
      throw new Error('当前 Workflow 并未等待人工处理。');
    }

    const currentNode = active.definition.nodes.find((node) => node.id === execution.currentNodeId);
    if (!currentNode || currentNode.actor !== 'human') {
      throw new Error('当前 Workflow 节点不是人工步骤。');
    }
    if (currentNode.id !== nodeId) {
      throw new Error('提交的人工节点不是当前 waiting 节点。');
    }

    const next = applyJourneyTransition(
      active.definition,
      execution,
      nodeId,
      outcome,
    );

    await withWorkspaceContextLock(name, async () => {
      const latestActive = await loadActiveJourney(name, workflowId);
      if (latestActive.source !== active.source || latestActive.version !== active.version) {
        throw new Error('Workflow 在人工处理期间发生变化，本次 transition 不再适用。');
      }

      const latest = await loadJourneyExecution(name, latestActive.definition, latestActive.version);
      if (
        latest.currentNodeId !== execution.currentNodeId
        || latest.workflowVersion !== execution.workflowVersion
        || latest.status !== execution.status
      ) {
        throw new Error('Workflow 执行状态已变化，请刷新后重新处理。');
      }

      await fs.mkdir(journeyDir(name), { recursive: true });
      await writeJsonAtomic(journeyFile(name, EXECUTION_FILE), next);
    });

    await appendJourneyTransitionEvents(name, execution, nodeId, outcome, next);
    await appendAuditEvent(name, {
      actor: 'user',
      action: 'workflow.human.transition',
      summary: 'Applied human Workflow outcome.',
      details: {
        workflowId,
        workflowVersion: active.version,
        nodeId,
        outcome,
        target: next.currentNodeId,
      },
    });

    return { applied: true, execution: next };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { applied: false, error: message };
  }
}


/** 给 Agent 的低 token Workflow 控制说明，只注入当前节点及其合法出口。 */
export async function buildJourneyAgentInstruction(
  name: string,
  workflowId: WorkflowId | null,
): Promise<string> {
  if (!workflowId) return '';

  const snapshot = await getJourneySnapshot(name, workflowId);
  const current = describeJourneyCurrentNode(
    snapshot.definition,
    snapshot.execution,
  );

  const completionLine = current.completeWhen
    ? '；completeWhen=' + current.completeWhen
    : '';

  const outcomes = current.outcomes.length
    ? '允许的出口：\n'
      + current.outcomes
        .map((item) =>
          '- ' + item.outcome + ' -> ' + item.target
          + (item.condition ? ' [condition=' + item.condition + ']' : '')
        )
        .join('\n')
    : '当前节点没有可用出口；请不要自行推进 Workflow。';

  return [
    '## Active Workflow Control',
    '当前 Investigation 有一条真正会影响执行位置的 Workflow，不是仅供参考的路线图。',
    'Workflow 节点和出口由服务端校验；Agent 不能自行发明 nodeId 或 outcome。',
    '',
    '当前节点：' + current.nodeId + '（' + current.title + '）',
    '节点类型：' + current.type,
    '执行者：' + current.actor,
    '节点目标：' + current.objective,
    '完成方式：' + current.completion + completionLine,
    ...(current.actor === 'human'
      ? ['这是人工步骤：Agent 不应假装已经完成，应等待用户确认或补充结果。']
      : []),
    '',
    outcomes,
    '',
    '当这一轮已经完成当前节点并有足够依据选择出口时，在最终 JSON 中额外返回：',
    '{"workflow":{"nodeId":"当前节点 ID","outcome":"允许的 outcome"}}',
    '如果这轮没有完成当前节点，或者不能可靠判断出口，不要返回 workflow 字段，不要猜。',
    '需要用户补充信息时，使用当前节点真正存在的 needs-input 等 outcome。',
  ].join('\n');
}

/** 返回当前 Workflow 的状态。 */
export async function getJourneyState(
  name: string,
  workflowId: WorkflowId,
): Promise<JourneyState> {
  const snapshot = await getJourneySnapshot(name, workflowId);
  return snapshot.state;
}
