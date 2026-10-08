/**
 * 工作地图编辑器的服务端存储边界。
 *
 * 这里连接三个彼此独立的东西：
 * 1. Skill 提供的内置 Workflow；
 * 2. Investigation 自己保存的 Workflow 定义和画布布局；
 * 3. 当前 Workflow execution。
 *
 * 重要原则：Definition 保存“做什么”，Layout 保存“怎么摆”，Execution 保存“现在做到哪”。
 * 三者不能混成一个文件，也不能把 X6 私有对象直接持久化。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { appendAuditEvent } from '../investigation/control.js';
import {
  ensureWorkspace,
  loadWorkspaceContext,
  contextFile,
  writeJsonAtomic,
  workspaceRoot,
  withWorkspaceContextLock,
} from '../investigation/workspace.js';
import { computeMissionFingerprint, computeScopeFingerprint } from '../investigation/artifact-provenance.js';
import { loadInvestigation, loadLatestSnapshot } from '../investigation/store.js';
import { buildArchitectureAssessmentPlan, loadArchitectureAssessmentPlan } from './assessment.js';
import { JourneyLayoutSchema, WorkflowSnapshotSchema, JourneyRunEventSchema, JourneyExecutionSchema } from '../api/contracts.js';
import { buildModernizationGaps } from '../analysis/gap.js';
import { parseAgentAnswer } from '../agent/result.js';
import { loadModernizationPlan, persistModernizationAgentResult } from './modernization.js';
import { runModernizationGate, type ModernizationGateStage } from './modernization-gate.js';
import { isCurrentStateOnlyScope, runInvestigationScopeGate } from './scope-gate.js';
import { assertMissionGate, isMissionWorkflowTargetAllowed } from './mission-gate.js';
import { buildMissionProgress } from './mission-progress.js';
import type { WorkflowId } from '../investigation/schemas.js';
import { isAgentWorkflowCompletionAllowed } from './journey.js';
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


const JOURNEY_DIR = 'workflow';
const JOURNEY_EVENT_WRITE_LOCKS = new Map<string, Promise<void>>();
const ACTIVE_FILE = 'journey.md';
const META_FILE = 'journey-meta.json';
const LAYOUT_FILE = 'journey-layout.json';
const EXECUTION_FILE = 'journey-execution.json';
const EVENTS_FILE = 'journey-run-events.jsonl';

export type JourneyLayout = z.infer<typeof JourneyLayoutSchema>;
export { JourneyLayoutNodeSchema, JourneyLayoutSchema } from '../api/contracts.js';

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

export type JourneySnapshot = z.infer<typeof WorkflowSnapshotSchema>;

/**
 * 比较两个 Workflow Execution 快照是否仍然代表同一个“可提交前状态”。
 *
 * Agent 计算 transition 与真正落盘之间存在天然的异步窗口：模型调用、Gate、
 * 用户操作都可能让 execution 先发生一次变化，再回到同一个 currentNodeId。
 * 只比较 currentNodeId 会留下典型的 ABA race，因此这里同时比较 version、status、
 * completedNodeIds 和 pendingInteraction，确保旧 transition 不能覆盖中间发生过的状态。
 */
export function sameJourneyExecution(left: JourneyExecution, right: JourneyExecution): boolean {
  return left.workflowId === right.workflowId
    && left.workflowVersion === right.workflowVersion
    && left.runId === right.runId
    && left.currentNodeId === right.currentNodeId
    && left.status === right.status
    && JSON.stringify(left.completedNodeIds) === JSON.stringify(right.completedNodeIds)
    && JSON.stringify(left.pendingInteraction ?? null) === JSON.stringify(right.pendingInteraction ?? null);
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
 *
 * 一个 Investigation 内可能同时存在 Agent transition、deterministic auto-advance、
 * 人工操作和 UI 读取请求；所有写入都必须串行，否则 JSONL 一旦交错，整个事件历史
 * 就无法被严格 Schema 重新读取。
 */
export async function appendJourneyRunEvent(name: string, event: JourneyRunEvent): Promise<void> {
  const validated = JourneyRunEventSchema.parse(event);
  const previous = JOURNEY_EVENT_WRITE_LOCKS.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  JOURNEY_EVENT_WRITE_LOCKS.set(name, queued);
  await previous.catch(() => undefined);

  try {
    await fs.mkdir(journeyDir(name), { recursive: true });
    await fs.appendFile(journeyFile(name, EVENTS_FILE), JSON.stringify(validated) + '\n', 'utf8');
  } finally {
    release();
    if (JOURNEY_EVENT_WRITE_LOCKS.get(name) === queued) JOURNEY_EVENT_WRITE_LOCKS.delete(name);
  }
}

/** 只读取最近事件供 UI/诊断使用；完整历史文件仍留在 workspace，不塞进当前快照。 */
export async function loadJourneyRunEvents(name: string, limit = 80): Promise<JourneyRunEvent[]> {
  const raw = await readTextOrNull(journeyFile(name, EVENTS_FILE));
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(Math.trunc(limit), 5000)));
  return lines.map((line) => JourneyRunEventSchema.parse(JSON.parse(line)) as JourneyRunEvent);
}

/**
 * 为没有历史坐标的 Workflow 生成初始布局。
 *
 * rank 只表达“从 start 大致经过多少层”；真正的画布排版由前端 workflow-v2 算法负责。
 * 这里仍提供一个稳定的兜底坐标，方便没有 Layout 文件时先生成合法数据。
 * 用户手动拖动后，坐标写入 layout 文件；再次打开时不应因为 Workflow runtime 改变而乱跳。
 */
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
  const mainLanePattern = [0, 1, 0, -1] as const;

  for (const [level, ids] of levels) {
    const mainLane = mainLanePattern[level % mainLanePattern.length] ?? 0;

    ids.forEach((id, index) => {
      // 与前端 workflow-v2 保持同一种视觉语言：主节点沿 S 型轨迹，分支向两侧展开。
      const side =
        index === 0
          ? mainLane
          : mainLane + (index % 2 === 1 ? -1 : 1) * Math.ceil(index / 2);

      nodes[id] = {
        x: 440 + side * 286,
        y: 56 + level * 172,
      };
    });
  }

  return { version: 1, engine: 'workflow-v2', nodes };
}

/**
 * 把当前 Definition 序列化成最小 Markdown DSL。
 *
 * 默认 actor 不写出来：task 默认 agent，review 默认 human。
 * 这样生成的文件尽量短，Git diff 也更容易看出真正的业务变化。
 */
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
    const defaultActor = node.type === 'review' ? 'human' : 'agent';
    if (node.actor !== defaultActor) lines.push('actor: ' + node.actor);
    if (node.completeWhen) lines.push('completeWhen: ' + node.completeWhen);
    for (const route of node.routes) {
      lines.push(
        '- ' + route.outcome + ' -> ' + route.target,
      );
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

type JourneyExecutionInput = Omit<JourneyExecution, 'runId' | 'pendingInteraction'> & {
  runId?: string | undefined;
  pendingInteraction?: JourneyExecution['pendingInteraction'] | undefined;
};

function normalizeExecution(
  definition: JourneyDefinition,
  version: number,
  execution: JourneyExecutionInput | null,
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
  if (!currentNode) return initialJourneyExecution(definition, version);

  const terminalStatus: JourneyExecution['status'] =
    currentNode.type === 'end'
      ? 'completed'
      : currentNode.actor === 'human'
        ? 'waiting'
        : 'active';

  const runId = execution.runId?.trim() || definition.id + '-v' + String(version);
  const completedNodeIds = [...new Set(
    execution.completedNodeIds.filter((id) =>
      definition.nodes.some((node) => node.id === id),
    ),
  )];

  const baseExecution: JourneyExecution = {
    workflowId: definition.id,
    workflowVersion: version,
    runId,
    currentNodeId: execution.currentNodeId,
    completedNodeIds,
    status: terminalStatus,
  };

  if (terminalStatus === 'waiting') {
    return {
      ...baseExecution,
      pendingInteraction: execution.pendingInteraction ?? {
        id: 'pending-' + runId + '-' + currentNode.id,
        nodeId: currentNode.id,
        reason: '等待人工完成“' + currentNode.title + '”。',
        requestedAt: new Date().toISOString(),
      },
    };
  }

  return baseExecution;
}

async function loadCustomActive(
  name: string,
  workflowId: WorkflowId,
): Promise<{ definition: JourneyDefinition; layout: JourneyLayout; version: number } | null> {
  const markdown = await readTextOrNull(journeyFile(name, ACTIVE_FILE));
  if (markdown === null) return null;

  const rawMeta = await readJson<unknown>(journeyFile(name, META_FILE));
  if (rawMeta === null) {
    throw new Error('自定义 Workflow 缺少 journey-meta.json，无法确认当前版本。请恢复完整的 Workflow 文件，或重置工作方式。');
  }
  const meta = JourneyMetaSchema.parse(rawMeta);
  if (meta.baseWorkflowId !== workflowId) {
    throw new Error('自定义 Workflow 与当前工作方式不匹配：' + meta.baseWorkflowId);
  }

  const parsed = parseJourneyMarkdown(markdown);
  if (!parsed.definition || parsed.issues.length) {
    throw new Error(
      'Investigation 自定义 Workflow 无效：\n' + parsed.issues.join('\n'),
    );
  }
  if (parsed.definition.id !== workflowId) {
    throw new Error('自定义工作方式的标识必须和当前选择保持一致：' + workflowId);
  }

  const rawLayout = await readJson<unknown>(journeyFile(name, LAYOUT_FILE));
  const layout = rawLayout === null
    ? defaultJourneyLayout(parsed.definition)
    : JourneyLayoutSchema.parse(rawLayout);

  return {
    definition: parsed.definition,
    layout,
    version: meta.version,
  };
}

/**
 * 从已有 Investigation 状态组装 deterministic facts。
 *
 * 这个函数绝不能为了判断 Workflow 又发起一次 Agent 调用；否则“是否完成”会变成不稳定的模型结果。
 * 当前四条内置 Workflow 共享一部分事实，因此这里暂时集中组装；真正需要扩展时优先改 evaluator，
 * 不要给 Markdown DSL 增加新的字段。
 */
async function buildJourneyFacts(name: string): Promise<JourneyFacts> {
  const context = await loadWorkspaceContext(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  // Workflow 地图只能读取已经落盘的 Modernization 工作成果，不能自己猜“这一关做完了”。
  const modernization = context.workflow === 'legacy-modernization'
    ? await loadModernizationPlan(name)
    : null;
  const assessment = context.workflow === 'data-architecture-assessment'
    ? await loadArchitectureAssessmentPlan(name)
    : null;
  const missionProgress = await buildMissionProgress(name, context.mission);
  const missionComplete = Boolean(
    missionProgress
    && missionProgress.deliverables
      .filter((item) => item.required)
      .every((item) => item.status === 'covered'),
  );
  return {
    goal: context.goal || context.userPrompt,
    scopeReady: context.scopeValidation?.status === 'validated',
    missionComplete,
    currentState: snapshot?.currentState
      ? {
          datasets: snapshot.currentState.coverage.datasets,
          semanticAssets: snapshot.currentState.coverage.semanticAssets,
          parseFailures: snapshot.currentState.coverage.sqlParseFailures,
          connectedDatasets: snapshot.currentState.coverage.connectedDatasets,
          sqlFiles: snapshot.currentState.coverage.sqlFiles,
          sqlParsedStatements: snapshot.currentState.coverage.sqlParsedStatements,
        }
      : null,
    unknowns: context.unknowns,
    findingCount: context.findings.length,
    highGapKinds: buildModernizationGaps({
      currentState: snapshot?.currentState ?? null,
      estate: snapshot?.estate ?? null,
      findings: context.findings,
    }).filter((gap) => gap.severity === 'high').map((gap) => gap.kind),
    targetStatus: modernization?.targetArchitecture.status ?? 'draft',
    targetComponentCount: modernization?.targetArchitecture.components.length ?? 0,
    mappingStatuses: modernization?.mappings.map((mapping) => mapping.status) ?? [],
    validationStatuses: modernization?.validationPlan.checks.map((check) => ({
      status: check.status,
      blocking: check.blocking,
    })) ?? [],
    estateColumnCount: snapshot?.estate?.nodes.filter((node) => node.type === 'column').length ?? 0,
    sourceOfTruthCandidateCount: snapshot?.currentState?.sourceOfTruthCandidates.length ?? 0,
    lineageEdgeCount: snapshot?.lineage?.edges.length ?? snapshot?.estate?.edges.length ?? 0,
    assessmentPlanExists: Boolean(assessment),
    assessmentFindingCount: assessment?.findings.length ?? context.findings.length,
    assessmentRecommendationCount: assessment?.recommendations.length ?? 0,
    assessmentRoadmapCount: assessment?.roadmap.length ?? 0,
  };
}

/**
 * 取得当前 Investigation 真正生效的 Workflow。
 *
 * 没有自定义文件时读取 Skill 内置版本；有自定义文件时读取 Investigation 保存的版本。
 * 这样“内置路线”和“本次调查已经调整过的路线”不会混淆。
 */
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

/**
 * 读取与当前 Definition version 绑定的 Execution。
 *
 * Workflow 定义发生版本变化后，旧 execution 不能直接套到新图上；normalizeExecution 会检查
 * workflowId、version 和 currentNodeId，发现不匹配就重新从 start 建立状态。
 */
export async function loadJourneyExecution(
  name: string,
  definition: JourneyDefinition,
  version: number,
): Promise<JourneyExecution> {
  const raw = await readJson<unknown>(journeyFile(name, EXECUTION_FILE));

  // execution 文件不存在时才代表“这条 Workflow 还没有执行状态”；如果文件存在但 schema 不对，
  // 绝不能悄悄回到 start，否则用户会看到路线倒退而不知道已有执行历史已经损坏。
  if (raw === null) return normalizeExecution(definition, version, null);
  const parsed = JourneyExecutionSchema.parse(raw);
  return normalizeExecution(definition, version, parsed);
}

/** 编辑器 / 右侧 Journey 共用的完整快照。 */
export async function getJourneySnapshot(
  name: string,
  workflowId: WorkflowId,
): Promise<JourneySnapshot> {
  // Definition、layout、execution 和 deterministic auto-advance 必须作为一个只读视图读取。
  // saveJourneyDefinition 同样持有这个锁，因此不会在五份文件更新到一半时读到混合版本。
  return withWorkspaceContextLock(name, async () => {
  const active = await loadActiveJourney(name, workflowId);
  const execution = await loadJourneyExecution(name, active.definition, active.version);
  const facts = await buildJourneyFacts(name);
  const state = buildJourneyState(active.definition, facts, execution);

  // Deterministic completion may move the current node without an Agent transition.
  // Persist that state so the next turn cannot observe an older current node.
  const executionChanged =
    state.execution.currentNodeId !== execution.currentNodeId
    || state.execution.status !== execution.status
    || state.execution.completedNodeIds.length !== execution.completedNodeIds.length
    || state.execution.completedNodeIds.some((id) => !execution.completedNodeIds.includes(id))
    || JSON.stringify(state.execution.pendingInteraction ?? null)
      !== JSON.stringify(execution.pendingInteraction ?? null);

  if (executionChanged) {
    const latest = await loadJourneyExecution(name, active.definition, active.version);
    // buildJourneyState() 可能需要读取多个持久化状态，期间 execution 有机会被其它请求推进后又回到原节点。
    // 只比较 currentNodeId 会留下 ABA race；必须确认完整快照仍与我们刚读到的版本一致。
    if (sameJourneyExecution(latest, execution)) {
      await fs.mkdir(journeyDir(name), { recursive: true });
      await writeJsonAtomic(journeyFile(name, EXECUTION_FILE), state.execution);
      await appendDeterministicAdvanceEvents(name, execution, state.execution);
    }
  }

  // 事件必须在自动推进持久化之后重新读取，否则本次 snapshot 会落后一轮。
  const events = await loadJourneyRunEvents(name);

  return WorkflowSnapshotSchema.parse({
    workflowId,
    source: active.source,
    baseWorkflowId: active.baseWorkflowId,
    version: active.version,
    definition: active.definition,
    layout: active.layout,
    execution: state.execution,
    state: {
      workflowId: state.workflowId,
      stages: state.stages,
    },
    events,
  });
  });
}

/** 图验证入口；同时检查每个节点是否有画布位置。 */
export function validateJourneyEdit(
  definitionInput: JourneyDefinition,
  layoutInput: JourneyLayout,
): { issues: string[] } {
  const definition = JourneyDefinitionSchema.parse(definitionInput);
  const layout = JourneyLayoutSchema.parse(layoutInput);
  const issues = validateJourneyDefinition(definition);
 
  for (const node of definition.nodes) {
    if (!layout.nodes[node.id]) issues.push('节点缺少画布位置：' + node.id);
  }

  return {
    issues: [...new Set(issues)],
  };
}

/**
 * 保存当前 Investigation 的 Workflow 版本。
 *
 * Definition 和 Layout 一起提交，但服务端先验证 Definition 的结构与每个节点坐标。
 * 验证失败时不会创建新版本。保存成功后才推进 Workflow version，并尽量把旧 execution
 * 的当前位置保留下来；如果当前节点已经不存在，则由 normalizeExecution 回到 start。
 */
export async function saveJourneyDefinition(
  name: string,
  workflowId: WorkflowId,
  definitionInput: JourneyDefinition,
  layoutInput: JourneyLayout,
): Promise<{ version: number; snapshot: JourneySnapshot }> {
  const definition = JourneyDefinitionSchema.parse(definitionInput);
  const layout = JourneyLayoutSchema.parse(layoutInput);

  if (definition.id !== workflowId) {
    throw new Error('不能把当前工作方式改成另一种工作方式。请先选择正确的工作方式。');
  }

  const validation = validateJourneyEdit(definition, layout);
  if (validation.issues.length) {
    throw new Error('工作方式检查没有通过：\n' + validation.issues.join('\n'));
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
    const migratedExecutionBase: JourneyExecution = {
      workflowId: definition.id,
      workflowVersion: nextVersion,
      runId: definition.id + '-v' + String(nextVersion),
      currentNodeId: preservedCurrent,
      completedNodeIds: preservedCompleted,
      status: preservedNode?.type === 'end'
        ? 'completed'
        : preservedNode?.actor === 'human'
            ? 'waiting'
            : 'active',
    };
    const migratedExecution: JourneyExecution = preservedNode?.actor === 'human'
      ? {
          ...migratedExecutionBase,
          pendingInteraction: {
            id: 'pending-' + definition.id + '-' + String(nextVersion),
            nodeId: preservedNode.id,
            reason: '等待人工完成“' + preservedNode.title + '”。',
            requestedAt: new Date().toISOString(),
          },
        }
      : migratedExecutionBase;

    await fs.mkdir(journeyDir(name), { recursive: true });
    await writeTextAtomic(journeyFile(name, ACTIVE_FILE), serializeJourneyMarkdown(definition));
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

    // Workflow 版本变化后，任何 Runtime Session 都不能继续携带旧 Workflow 上下文。
    const current = await loadWorkspaceContext(name);
    const nextContext = { ...current };
    delete nextContext.agentSessionId;
    delete nextContext.agentSessionRuntime;
    delete nextContext.agentConfigurationVersion;
    delete nextContext.copilotSessionId;
    delete nextContext.copilotConfigurationVersion;
    delete nextContext.journeyPlan;
    await writeJsonAtomic(contextFile(name), {
      ...nextContext,
      updatedAt: new Date().toISOString(),
    });

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
    if (events) await writeTextAtomic(journeyFile(name, EVENTS_FILE), events);
    const current = await loadWorkspaceContext(name);
    const nextContext = { ...current };
    delete nextContext.agentSessionId;
    delete nextContext.agentSessionRuntime;
    delete nextContext.agentConfigurationVersion;
    delete nextContext.copilotSessionId;
    delete nextContext.copilotConfigurationVersion;
    delete nextContext.journeyPlan;
    await writeJsonAtomic(contextFile(name), {
      ...nextContext,
      updatedAt: new Date().toISOString(),
    });
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
 * deterministic 节点也会真正推进 execution，所以这里补写最小运行事件，
 * 保证“执行状态”和“运行轨迹”不会因为自动推进而出现缺口。
 */
async function appendDeterministicAdvanceEvents(
  name: string,
  before: JourneyExecution,
  after: JourneyExecution,
): Promise<void> {
  const completedBefore = new Set(before.completedNodeIds);
  const newlyCompleted = after.completedNodeIds.filter((id) => !completedBefore.has(id));

  for (const nodeId of newlyCompleted) {
    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: after.runId,
      workflowId: after.workflowId,
      workflowVersion: after.workflowVersion,
      type: 'node-completed',
      timestamp: new Date().toISOString(),
      nodeId,
      data: { deterministic: true },
    });
  }

  if (
    before.status !== 'waiting'
    && after.status === 'waiting'
    && after.pendingInteraction
  ) {
    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: after.runId,
      workflowId: after.workflowId,
      workflowVersion: after.workflowVersion,
      type: 'node-waiting',
      timestamp: new Date().toISOString(),
      nodeId: after.pendingInteraction.nodeId,
      data: { ...after.pendingInteraction, deterministic: true },
    });
  } else if (before.status !== 'completed' && after.status === 'completed') {
    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: after.runId,
      workflowId: after.workflowId,
      workflowVersion: after.workflowVersion,
      type: 'workflow-completed',
      timestamp: new Date().toISOString(),
      nodeId: after.currentNodeId,
      data: { deterministic: true },
    });
  }
}

/**
 * Legacy Modernization 的关键工作阶段对应确定性 Gate。
 *
 * 自定义 Workflow 允许改变节点标题和图结构，因此同时兼容内置 node id 和默认中文标题。
 * 其它 Workflow 不走这套业务 Gate，避免把 modernization 规则泄漏到通用 Workflow。
 */
function modernizationGateStage(
  node: JourneyDefinition['nodes'][number],
): ModernizationGateStage | null {
  if (node.id === 'target' || node.title === '设计新方案') return 'target';
  if (node.id === 'mapping' || node.title === '新旧对应') return 'mapping';
  if (node.id === 'validation' || node.title === '验证结果') return 'validation';
  return null;
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
  }
}

/**
 * 将 Agent 返回的合法 outcome 写入 durable Execution。
 *
 * Agent 只能提出当前节点已经声明的 outcome；真正的 target 由 applyJourneyTransition
 * 根据 Workflow Definition 查找。这样模型不会直接控制 Workflow 的跳转边界。
 *
 * persistModernizationResult=false 只用于 Investigation Agent 的 pre-transition Stage Gate：
 * Ask Flow 已经先保存本轮 work product，避免重复写入同一结果并把 version 无意义地加一。
 * 其它直接调用方保持旧行为，默认仍会保存 Modernization work product。
 */
export async function applyAgentWorkflowTransition(
  name: string,
  workflowId: WorkflowId | null,
  rawAnswer: string,
  options: { persistModernizationResult?: boolean; stageValidationPassed?: boolean } = {},
): Promise<{ applied: boolean; error?: string; execution?: JourneyExecution }> {
  if (!workflowId) return { applied: false };
  const initialContext = await loadInvestigation(name);
  const mission = assertMissionGate(initialContext.mission);
  // 绑定 transition 开始时的 Mission / Scope。后面的模型审核、Gate 和文件操作都可能等待；
  // 用户若在等待期间修改任务，这次 transition 必须失效，不能把旧任务结果写回去。
  const expectedMissionFingerprint = computeMissionFingerprint(initialContext);
  const expectedScopeFingerprint = computeScopeFingerprint(initialContext);

  /**
   * 先解析 Agent 提出的 outcome，并检查 Mission / Workflow 边界。
   *
   * 重要顺序：
   * 1. 先确定 Agent 到底想推进哪条边；
   * 2. 先检查 Mission 是否允许进入目标节点；
   * 3. 再保存这一阶段的 Modernization 工作成果。
   *
   * 这样“用户没有要求的结果”不会先落盘，再被 Gate 拒绝。
   */
  const transition = extractWorkflowTransition(rawAnswer);
  if (!transition) return { applied: false };

  let eventRunId = workflowId + '-rejected';
  let eventWorkflowVersion = 0;

  try {
    const active = await loadActiveJourney(name, workflowId);
    const execution = await loadJourneyExecution(
      name,
      active.definition,
      active.version,
    );
    eventRunId = execution.runId;
    eventWorkflowVersion = execution.workflowVersion;
    const currentNode = active.definition.nodes.find((node) => node.id === execution.currentNodeId);
    if (execution.status === 'waiting' || currentNode?.actor === 'human') {
      throw new Error('这一步正在等待你的处理，助手不能替你完成。请先完成当前人工步骤。');
    }

    const route = currentNode?.routes.find((item) =>
      item.outcome.toLowerCase() === transition.outcome.toLowerCase(),
    );

    // Mission / Scope / Workflow 边界必须先通过，再允许落盘本阶段的方案成果。
    if (transition.outcome === 'success' && route) {
      const context = await loadInvestigation(name);
      const currentStateOnly = isCurrentStateOnlyScope(context.goal, context.scope);
      if (
        currentStateOnly
        && ['target', 'mapping', 'validation', 'cutover'].includes(route.target)
      ) {
        throw new Error('本次调查范围明确只包含当前状态分析，不能进入目标架构、迁移映射或切换阶段；如需继续，请先由用户明确调整范围。');
      }

      const missionBoundary = isMissionWorkflowTargetAllowed(
        mission,
        route.target,
        active.definition.nodes.find((node) => node.id === route.target)?.title,
      );
      if (!missionBoundary.allowed) {
        throw new Error(missionBoundary.reason ?? '当前 Workflow 下一阶段不属于本次任务结果范围。');
      }

      const targetNode = active.definition.nodes.find((node) => node.id === route.target);
      if (targetNode?.type === 'end') {
        const progress = await buildMissionProgress(name, mission);
        const uncovered = progress?.deliverables.filter(
          (item) => item.required && item.status !== 'covered' && item.status !== 'not_tracked',
        ) ?? [];
        if (uncovered.length) {
          throw new Error(
            '本次任务还有未完成的结果：'
            + uncovered.map((item) => item.title).join('、')
            + '。请先完成这些结果，再结束 Workflow。',
          );
        }
      }
    }

    if (
      workflowId === 'data-architecture-assessment'
      && transition.outcome === 'success'
      && currentNode
      && ['assessment-findings', 'assessment-recommendation', 'assessment-roadmap'].includes(currentNode.completeWhen ?? '')
    ) {
      try {
        await buildArchitectureAssessmentPlan(name);
      } catch (error) {
        return {
          applied: false,
          error: '保存 Data Architecture Assessment 结果失败：'
            + (error instanceof Error ? error.message : String(error)),
        };
      }
    }

    if (workflowId === 'legacy-modernization' && options.persistModernizationResult !== false) {
      try {
        const latestInvestigation = await loadInvestigation(name);
        const evidenceMap = new Map(latestInvestigation.evidence.map((evidence) => [evidence.id, evidence]));
        const parsed = parseAgentAnswer(rawAnswer, evidenceMap);
        await persistModernizationAgentResult(name, parsed.modernization);
      } catch (error) {
        return {
          applied: false,
          error: '保存 Modernization 工作成果失败：' + (error instanceof Error ? error.message : String(error)),
        };
      }
    }

    if (transition.outcome === 'success' && currentNode) {
      const facts = await buildJourneyFacts(name);
      const completionAllowed = isAgentWorkflowCompletionAllowed(
        currentNode,
        facts,
        options.stageValidationPassed === true,
      );
      if (!completionAllowed) {
        if (currentNode.completeWhen) {
          throw new Error(
            '当前步骤的完成条件还没有满足，不能由助手自己宣布完成：'
              + ' completeWhen=' + currentNode.completeWhen,
          );
        }
        if (currentNode.actor === 'agent') {
          throw new Error(
            '当前步骤没有直接的完成条件，必须先通过阶段成果检查才能继续。',
          );
        }
      }
    }

    if (transition.outcome === 'success' && currentNode?.id === active.definition.start) {
      const scopeGate = await runInvestigationScopeGate(name);
      if (!scopeGate.passed) {
        const failed = scopeGate.checks
          .filter((item) => !item.passed)
          .map((item) => item.name + '：' + item.detail)
          .join('；');
        throw new Error(
          'Workflow Intake Gate 未通过，当前阶段不能完成。'
          + (failed ? ' ' + failed : ''),
        );
      }
    }

    const gateStage = workflowId === 'legacy-modernization' && currentNode
      ? modernizationGateStage(currentNode)
      : null;
    if (transition.outcome === 'success' && gateStage) {
      const gate = await runModernizationGate(name, gateStage);
      if (!gate.passed) {
        const failed = gate.checks
          .filter((item) => !item.passed)
          .map((item) => item.name + '：' + item.detail)
          .join('；');
        throw new Error(
          '这一阶段还不能完成，请先补齐当前步骤要求的结果。'
          + (failed ? ' ' + failed : ''),
        );
      }
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
        throw new Error('执行期间工作方式发生了变化，这一步已经失效。请刷新页面后重新选择下一步。');
      }

      const latest = await loadJourneyExecution(
        name,
        latestActive.definition,
        latestActive.version,
      );

      const latestContext = await loadWorkspaceContext(name);
      if (
        computeMissionFingerprint(latestContext) !== expectedMissionFingerprint
        || computeScopeFingerprint(latestContext) !== expectedScopeFingerprint
      ) {
        throw new Error('任务或调查范围在 Workflow 推进期间发生了变化，这一步已经失效，请刷新后重新处理。');
      }

      if (!sameJourneyExecution(latest, execution)) {
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
      runId: eventRunId,
      workflowId,
      workflowVersion: eventWorkflowVersion,
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
  let eventRunId = workflowId + '-rejected';
  let eventWorkflowVersion = 0;

  try {
    const context = await loadWorkspaceContext(name);
    const mission = assertMissionGate(context.mission);
    // 人工操作也必须绑定当时看到的任务和范围，不能把旧页面的选择提交到新 Mission。
    const expectedMissionFingerprint = computeMissionFingerprint(context);
    const expectedScopeFingerprint = computeScopeFingerprint(context);
    const active = await loadActiveJourney(name, workflowId);
    const execution = await loadJourneyExecution(name, active.definition, active.version);
    eventRunId = execution.runId;
    eventWorkflowVersion = execution.workflowVersion;
    if (execution.status !== 'waiting') {
      throw new Error('当前没有需要你处理的人工步骤。');
    }

    const currentNode = active.definition.nodes.find((node) => node.id === execution.currentNodeId);
    if (!currentNode || currentNode.actor !== 'human') {
      throw new Error('当前步骤不需要人工处理。');
    }
    if (currentNode.id !== nodeId) {
      throw new Error('你提交的步骤已经不是当前等待处理的步骤，请刷新后再试。');
    }

    if (outcome === 'approved') {
      const route = currentNode.routes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase());
      if (route) {
        const targetNode = active.definition.nodes.find((item) => item.id === route.target);
        if (targetNode?.type === 'end') {
          // 不论 outcome 是 approved 还是其它自定义出口，只要目标是 @end，就必须先检查 Mission。
          // 这样自定义 Workflow 无法通过“非 approved 的特殊出口”绕过最终结果检查。
          const progress = await buildMissionProgress(name, mission);
          const uncovered = progress?.deliverables.filter(
            (item) => item.required && item.status !== 'covered' && item.status !== 'not_tracked',
          ) ?? [];
          if (uncovered.length) {
            throw new Error(
              '本次任务还有未完成的结果：'
              + uncovered.map((item) => item.title).join('、')
              + '。请先完成这些结果，再结束 Workflow。',
            );
          }
        }
        if (outcome === 'approved') {
          const missionBoundary = isMissionWorkflowTargetAllowed(
          mission,
          route.target,
          active.definition.nodes.find((node) => node.id === route.target)?.title,
        );
          if (!missionBoundary.allowed) {
            throw new Error(missionBoundary.reason ?? '当前 Workflow 下一阶段不属于本次任务结果范围。');
          }
        }
      }
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
        throw new Error('你处理期间工作方式发生了变化，这一步已经失效。请刷新页面后重新处理。');
      }

      const latest = await loadJourneyExecution(name, latestActive.definition, latestActive.version);
      const latestContext = await loadWorkspaceContext(name);
      if (
        computeMissionFingerprint(latestContext) !== expectedMissionFingerprint
        || computeScopeFingerprint(latestContext) !== expectedScopeFingerprint
      ) {
        throw new Error('任务或调查范围在处理期间发生了变化，这一步已经失效，请刷新后重新处理。');
      }
      if (!sameJourneyExecution(latest, execution)) {
        throw new Error('执行状态已经变化，请刷新页面后重新处理。');
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

    await appendJourneyRunEvent(name, {
      id: crypto.randomUUID(),
      runId: eventRunId,
      workflowId,
      workflowVersion: eventWorkflowVersion,
      type: 'transition-rejected',
      timestamp: new Date().toISOString(),
      nodeId,
      outcome,
      error: message,
    });

    // Human transition 的拒绝同样属于重要控制面事件，不能只有 UI 返回错误而没有审计记录。
    try {
      await appendAuditEvent(name, {
        actor: 'user',
        action: 'workflow.human.transition.rejected',
        summary: 'Rejected invalid human Workflow outcome.',
        details: {
          workflowId,
          nodeId,
          outcome,
          error: message,
        },
      });
    } catch (auditError) {
      console.error('[workflow] Failed to persist rejected human transition audit.', {
        sessionName: name,
        workflowId,
        nodeId,
        outcome,
        error: auditError,
      });
    }

    return { applied: false, error: message };
  }
}

/**
 * 给 Agent 注入当前 Workflow 控制说明。
 *
 * 这里只发送当前节点、目标和合法出口，避免每一轮重复把整张 Workflow 重新写进上下文。
 * 它是运行时提示，不是授权机制；服务端 transition 仍然是最终校验点。
 */
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
  const context = await loadWorkspaceContext(name);
  const overallGoal = context.mission?.purpose.trim() || context.goal.trim() || context.userPrompt.trim();

  const outcomes = current.outcomes.length
    ? '允许的出口：\n'
      + current.outcomes
        .map((item) =>
          '- ' + item.outcome + ' -> ' + item.target

        )
        .join('\n')
    : '当前节点没有可用出口；请不要自行推进 Workflow。';

  return [
    '## Active Workflow Control',
    '当前 Investigation 有一条真正会影响执行位置的 Workflow，不是仅供参考的路线图。',
    'Workflow 节点和出口由服务端校验；Agent 不能自行发明 nodeId 或 outcome。',
    '',
    ...(context.mission
      ? [
          '最高优先级：本次任务。',
          '任务目的（为什么做）：' + context.mission.purpose,
          '期望结果（最后要拿到什么）：' + context.mission.expectedResult,
          '当前 Workflow 只是实现 Mission 的路线，不能改变任务目的或期望结果。',
          '只有仍然存在与 Mission 直接相关、而且值得完成的工作时才继续；不要为了填满 Workflow、解决无关 unknown 或寻找“关键问题”而推进。',
        ]
      : ['整个 Investigation 要完成的任务：' + (overallGoal || '（未设置）')]),
    '不要把当前节点当成一个独立问题；它只是完成 Mission 的当前导航位置。',
    '当前节点：' + current.nodeId + '（' + current.title + '）',
    '节点类型：' + current.type,
    '执行者：' + current.actor,
    '节点目标：' + current.objective,
    ...(current.completeWhen ? ['确定性条件：' + current.completeWhen] : []),
    ...(current.actor === 'human'
      ? ['这是人工步骤：Agent 不应假装已经完成，应等待用户确认或补充结果。']
      : []),
    '',
    outcomes,
    '',
    '调查动作与 Workflow 推进是两件事：即使当前节点的 completeWhen 尚未满足，也可以先调查并收集事实；只有真正满足条件并选择了合法出口时，才返回 workflow 字段。',
    '少量 open question 不等于当前阶段失败；如果还有其它重要工作可以完成，应继续推进。',
    '{"workflow":{"nodeId":"当前节点 ID","outcome":"允许的 outcome"}}',
    '如果这轮没有完成当前节点，或者不能可靠判断出口，不要返回 workflow 字段，不要猜。',
    '需要用户补充信息时，不要猜；应由当前 Workflow 中真实存在的人工步骤或 outcome 决定。',
  ].join('\n');
}

/** 返回当前 Workflow 的状态。 */
export async function getJourneyState(
  name: string,
  workflowId: WorkflowId,
): Promise<JourneyState> {
  const snapshot = await getJourneySnapshot(name, workflowId);
  return { ...snapshot.state, execution: snapshot.execution };
}
