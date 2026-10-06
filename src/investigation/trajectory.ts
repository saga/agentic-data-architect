import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { workspaceRoot } from './workspace.js';

export const TrajectoryEventSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  timestamp: z.string().datetime(),
  type: z.enum(['user_input','turn_start','assistant_turn_start','assistant_turn_end','intent','model_call','tool_call','tool_result','tool_progress','permission','permission_completed','user_input_requested','user_input_completed','compaction','session_idle','session_error','context_changed','turn_end','error','checkpoint','stage_gate','status']),
  name: z.string().min(1),
  status: z.enum(['started','completed','failed','waiting','info']).optional(),
  durationMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  premiumRequestCost: z.number().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;

export const TrajectorySummarySchema = z.object({
  turnId: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  totalTokens: z.number().nonnegative().default(0),
  totalNanoAiu: z.number().nonnegative().optional(),
  totalPremiumRequestCost: z.number().nonnegative().optional(),
  models: z.record(z.string(), z.object({
    inputTokens: z.number().nonnegative().default(0),
    outputTokens: z.number().nonnegative().default(0),
    totalNanoAiu: z.number().nonnegative().optional(),
  }).strict()).default({}),
  eventCount: z.number().int().nonnegative().default(0),
  state: z.enum(['running', 'waiting', 'completed', 'failed', 'aborted']).default('running'),
  waitingOn: z.enum(['permission', 'user_input', 'tool', 'model', 'session']).optional(),
  lastActivityAt: z.string().datetime().optional(),
  lastActivity: z.string().optional(),
  lastActivityType: z.string().optional(),
  idleObserved: z.boolean().default(false),
  assistantTurnEnded: z.boolean().default(false),
  pendingToolCount: z.number().int().nonnegative().default(0),
  pendingPermissionCount: z.number().int().nonnegative().default(0),
  pendingUserInputCount: z.number().int().nonnegative().default(0),
}).strict();
export type TrajectorySummary = z.infer<typeof TrajectorySummarySchema>;

export interface TrajectoryTurnSummary {
  turnId: string;
  summary: TrajectorySummary;
  userQuestion?: string;
  modelCalls: number;
  toolCalls: number;
  failedEvents: number;
  compactions: number;
}

export function summarizeTrajectoryTurns(events: TrajectoryEvent[]): TrajectoryTurnSummary[] {
  const groups = new Map<string, TrajectoryEvent[]>();
  for (const event of events) {
    const group = groups.get(event.turnId) ?? [];
    group.push(event);
    groups.set(event.turnId, group);
  }

  return [...groups.values()]
    .sort((a, b) => a[0]!.timestamp.localeCompare(b[0]!.timestamp))
    .map((turnEvents) => {
      const userEvent = turnEvents.find((event) => event.type === 'user_input');
      const turnEnd = [...turnEvents].reverse().find((event) => event.type === 'turn_end');
      const turnUsage = turnEnd?.details.turnUsage;
      const usageObject = turnUsage && typeof turnUsage === 'object'
        ? turnUsage as Record<string, unknown>
        : undefined;
      const summary = summarizeTrajectory(turnEvents, usageObject);
      return {
        turnId: turnEvents[0]!.turnId,
        summary: summary ?? TrajectorySummarySchema.parse({
          turnId: turnEvents[0]!.turnId,
          startedAt: turnEvents[0]!.timestamp,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          eventCount: turnEvents.length,
        }),
        ...(typeof userEvent?.details.question === 'string'
          ? { userQuestion: userEvent.details.question }
          : {}),
        modelCalls: turnEvents.filter((event) => event.type === 'model_call').length,
        toolCalls: turnEvents.filter((event) => event.type === 'tool_call').length,
        failedEvents: turnEvents.filter((event) => event.status === 'failed').length,
        compactions: turnEvents.filter((event) => event.type === 'compaction').length,
      };
    });
}

function trajectoryFile(name: string): string {
  return path.join(workspaceRoot(name), 'trajectory.jsonl');
}

/** 追加一条 Agent 执行轨迹；不记录思维链正文，只记录可审查的运行事件。 */
export async function appendTrajectoryEvent(name: string, event: Omit<TrajectoryEvent, 'id' | 'timestamp'> & Partial<Pick<TrajectoryEvent, 'timestamp'>>): Promise<TrajectoryEvent> {
  const full = TrajectoryEventSchema.parse({ id: randomUUID(), timestamp: new Date().toISOString(), ...event });
  await fs.appendFile(trajectoryFile(name), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

/** 读取最近的执行轨迹；UI 可按 turnId 再筛选。 */
export async function readTrajectory(name: string, options: { turnId?: string; limit?: number } = {}): Promise<TrajectoryEvent[]> {
  let text = '';
  try { text = await fs.readFile(trajectoryFile(name), 'utf8'); } catch { return []; }
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 500), 5000));
  const lines = text.split('\n').filter(Boolean);
  const events: TrajectoryEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      events.push(TrajectoryEventSchema.parse(JSON.parse(lines[index] as string)));
    } catch (error) {
      throw new Error('Trajectory 数据损坏：第 ' + String(index + 1) + ' 行无法通过 schema validation。' + (error instanceof Error ? ' ' + error.message : ''));
    }
  }
  const filtered = options.turnId ? events.filter((event) => event.turnId === options.turnId) : events;
  return filtered.slice(-limit);
}

/** 读取最近的阶段性调查小结；checkpoint 本身作为 trajectory 的可追溯事件保存。 */
export interface TrajectoryCheckpoint {
  id: string;
  turnId: string;
  timestamp: string;
  execution: number;
  title: string;
  summary: string;
  confirmed: string[];
  evidenceIds: string[];
  unknowns: string[];
  nextStep?: string;
}

const trajectoryCheckpointDetails = z.object({
  execution: z.number().int().nonnegative(),
  title: z.string().min(1),
  summary: z.string().min(1),
  confirmed: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  nextStep: z.string().optional(),
}).strict();

export function listTrajectoryCheckpoints(events: TrajectoryEvent[], limit = 20): TrajectoryCheckpoint[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  return events
    .filter((event) => event.type === 'checkpoint')
    .map((event) => {
      const parsed = trajectoryCheckpointDetails.safeParse(event.details);
      if (!parsed.success) return null;
      return {
        id: event.id,
        turnId: event.turnId,
        timestamp: event.timestamp,
        ...parsed.data,
      };
    })
    .filter((item): item is TrajectoryCheckpoint => Boolean(item))
    .slice(-safeLimit);
}

/** 从 trajectory events 汇总 token、Premium Request Cost 和时间；最终 AI credit 以 SDK usage.getMetrics 为准。 */
export function summarizeTrajectory(events: TrajectoryEvent[], usage?: unknown): TrajectorySummary | null {
  if (!events.length) return null;

  // 总 Token / Premium Cost 统计跨所有历史轮次；运行状态只看“最近一轮”。
  // 否则第一轮曾经 timeout / waiting permission，会把后来已经成功完成的轮次误报成异常。
  const latestTurnId = events.at(-1)!.turnId;
  const latestTurnEvents = events.filter((event) => event.turnId === latestTurnId);
  const first = latestTurnEvents[0] ?? events[0]!;
  const usageObject = usage && typeof usage === 'object'
    ? usage as Record<string, unknown>
    : undefined;

  const model = [...events].reverse().find((event) => event.model)?.model;
  const inputEventTokens = events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0);
  const outputEventTokens = events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0);
  const totalEventTokens = inputEventTokens + outputEventTokens;
  const eventPremiumRequestCost = events.reduce((sum, event) => sum + (event.premiumRequestCost ?? 0), 0);

  const turnUsageValues = events
    .filter((event) => event.type === 'turn_end' && event.details.turnUsage && typeof event.details.turnUsage === 'object')
    .map((event) => event.details.turnUsage as Record<string, unknown>);

  const summedTurnNanoAiu = turnUsageValues.reduce(
    (sum, item) => sum + (typeof item.totalNanoAiu === 'number' ? item.totalNanoAiu : 0),
    0,
  );
  const summedTurnPremiumCost = turnUsageValues.reduce(
    (sum, item) => sum + (typeof item.totalPremiumRequestCost === 'number' ? item.totalPremiumRequestCost : 0),
    0,
  );

  const usageInput = usageObject?.inputTokens;
  const usageOutput = usageObject?.outputTokens;
  const usageTotal = usageObject?.totalTokens;

  const models: TrajectorySummary['models'] = {};
  for (const event of events.filter((item) => item.type === 'model_call')) {
    const modelName = event.model ?? '未知模型';
    const item = models[modelName] ?? { inputTokens: 0, outputTokens: 0 };
    item.inputTokens += event.inputTokens ?? 0;
    item.outputTokens += event.outputTokens ?? 0;
    models[modelName] = item;
  }

  const usageModels = usageObject?.modelMetrics;
  if (usageModels && typeof usageModels === 'object') {
    for (const [name, raw] of Object.entries(usageModels as Record<string, unknown>)) {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const usageBlock = item.usage && typeof item.usage === 'object' ? item.usage as Record<string, unknown> : {};
      models[name] = {
        inputTokens: typeof usageBlock.inputTokens === 'number' ? usageBlock.inputTokens : models[name]?.inputTokens ?? 0,
        outputTokens: typeof usageBlock.outputTokens === 'number' ? usageBlock.outputTokens : models[name]?.outputTokens ?? 0,
        ...(typeof item.totalNanoAiu === 'number' ? { totalNanoAiu: item.totalNanoAiu } : {}),
      };
    }
  }

  const hasTurnNanoAiu = turnUsageValues.some((item) => typeof item.totalNanoAiu === 'number');
  const hasTurnPremiumCost = turnUsageValues.some((item) => typeof item.totalPremiumRequestCost === 'number');

  const totalNanoAiu = hasTurnNanoAiu
    ? summedTurnNanoAiu
    : typeof usageObject?.totalNanoAiu === 'number'
      ? usageObject.totalNanoAiu
      : undefined;

  const totalPremiumRequestCost = hasTurnPremiumCost
    ? summedTurnPremiumCost
    : eventPremiumRequestCost > 0
      ? eventPremiumRequestCost
      : typeof usageObject?.totalPremiumRequestCost === 'number'
        ? usageObject.totalPremiumRequestCost
        : undefined;

  const completionEvent = [...latestTurnEvents].reverse().find((event) =>
    event.type === 'turn_end'
    || (event.type === 'status' && event.name === '结果已保存')
    || event.type === 'error'
  );
  const finishedAt = completionEvent?.timestamp;
  const diagnostics = deriveTrajectoryDiagnostics(latestTurnEvents);
  return TrajectorySummarySchema.parse({
    turnId: latestTurnId,
    startedAt: first.timestamp,
    ...(finishedAt ? {
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(first.timestamp).getTime(),
    } : {}),
    ...(model ? { model } : {}),
    inputTokens: typeof usageInput === 'number' ? usageInput : inputEventTokens,
    outputTokens: typeof usageOutput === 'number' ? usageOutput : outputEventTokens,
    totalTokens: typeof usageTotal === 'number' ? usageTotal : totalEventTokens,
    ...(totalNanoAiu !== undefined ? { totalNanoAiu } : {}),
    ...(totalPremiumRequestCost !== undefined ? { totalPremiumRequestCost } : {}),
    models,
    eventCount: events.length,
    ...diagnostics,
  });
}

function deriveTrajectoryDiagnostics(events: TrajectoryEvent[]): {
  state: TrajectorySummary['state'];
  waitingOn?: TrajectorySummary['waitingOn'];
  lastActivityAt?: string;
  lastActivity?: string;
  lastActivityType?: string;
  idleObserved: boolean;
  assistantTurnEnded: boolean;
  pendingToolCount: number;
  pendingPermissionCount: number;
  pendingUserInputCount: number;
} {
  const pendingTools = new Set<string>();
  const pendingPermissions = new Set<string>();
  const pendingUserInputs = new Set<string>();
  let lastActivityAt: string | undefined;
  let lastActivity: string | undefined;
  let lastActivityType: string | undefined;
  let idleObserved = false;
  let assistantTurnEnded = false;
  let terminalFailure = false;

  for (const event of events) {
    lastActivityAt = event.timestamp;
    lastActivityType = event.type;
    lastActivity = event.name;

    // 自动续跑会在多个 sendAndWait 阶段之间产生 session_idle。
    // 只要 idle 后又出现新的模型/工具活动，就不能把这个 idle 当成本轮最终完成。
    if (event.type === 'model_call'
      || event.type === 'tool_call'
      || event.type === 'tool_result'
      || event.type === 'tool_progress'
      || event.type === 'assistant_turn_start'
      || event.type === 'user_input'
      || event.type === 'permission'
      || event.type === 'permission_completed'
      || event.type === 'user_input_requested'
      || event.type === 'user_input_completed') {
      idleObserved = false;
      terminalFailure = false;
    }

    if (event.type === 'tool_call' && event.status === 'started') {
      const id = event.details.toolCallId;
      if (typeof id === 'string' && id) pendingTools.add(id);
    }
    if (event.type === 'tool_result') {
      const id = event.details.toolCallId;
      if (typeof id === 'string' && id) pendingTools.delete(id);
    }

    if (event.type === 'permission' && event.status === 'waiting') {
      const id = typeof event.details.requestId === 'string' ? event.details.requestId : event.id;
      pendingPermissions.add(id);
    }
    if (event.type === 'permission_completed') {
      const id = typeof event.details.requestId === 'string' ? event.details.requestId : '';
      if (id) pendingPermissions.delete(id);
    }

    if (event.type === 'user_input_requested' && event.status === 'waiting') {
      const id = typeof event.details.requestId === 'string' ? event.details.requestId : event.id;
      pendingUserInputs.add(id);
    }
    if (event.type === 'user_input_completed') {
      const id = typeof event.details.requestId === 'string' ? event.details.requestId : '';
      if (id) pendingUserInputs.delete(id);
    }

    if (event.type === 'assistant_turn_end') assistantTurnEnded = true;
    if (event.type === 'session_idle') {
      idleObserved = true;
      terminalFailure = false;
    }
    // 工具失败、单次上下文整理失败并不一定终止整轮；Agent 可能捕获后继续。
    // 只有 turn-level error / session.error 才把整轮标成 failed。
    if (event.type === 'error' || event.type === 'session_error') {
      terminalFailure = true;
      idleObserved = false;
    }
    if (event.type === 'turn_end') {
      idleObserved = true;
      terminalFailure = false;
    }
  }

  let state: TrajectorySummary['state'];
  if (terminalFailure) state = 'failed';
  else if (idleObserved || events.some((event) => event.type === 'turn_end')) state = 'completed';
  else if (pendingPermissions.size > 0 || pendingUserInputs.size > 0) state = 'waiting';
  else state = 'running';

  const waitingOn: TrajectorySummary['waitingOn'] =
    pendingPermissions.size > 0 ? 'permission' :
    pendingUserInputs.size > 0 ? 'user_input' :
    pendingTools.size > 0 ? 'tool' :
    state === 'running' ? 'model' :
    undefined;

  return {
    state,
    ...(waitingOn ? { waitingOn } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(lastActivity ? { lastActivity } : {}),
    ...(lastActivityType ? { lastActivityType } : {}),
    idleObserved,
    assistantTurnEnded,
    pendingToolCount: pendingTools.size,
    pendingPermissionCount: pendingPermissions.size,
    pendingUserInputCount: pendingUserInputs.size,
  };
}

function totalFromUsage(usage: unknown, field: 'inputTokens' | 'outputTokens' | 'totalTokens', fallback: number): number {
  if (!usage || typeof usage !== 'object') return fallback;
  const value = (usage as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : fallback;
}