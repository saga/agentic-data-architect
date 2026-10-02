import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { workspaceRoot } from './workspace.js';

export const TrajectoryEventSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  timestamp: z.string().datetime(),
  type: z.enum(['turn_start','intent','model_call','tool_call','tool_result','permission','compaction','turn_end','error','status']),
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
  turnId: z.string().min(1),
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
}).strict();
export type TrajectorySummary = z.infer<typeof TrajectorySummarySchema>;

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
  const events = text.split('\n').filter(Boolean).map((line) => { try { return TrajectoryEventSchema.parse(JSON.parse(line)); } catch { return null; } }).filter((event): event is TrajectoryEvent => Boolean(event));
  const filtered = options.turnId ? events.filter((event) => event.turnId === options.turnId) : events;
  return filtered.slice(-limit);
}

/** 从 trajectory events 汇总 token、Premium Request Cost 和时间；最终 AI credit 以 SDK usage.getMetrics 为准。 */
export function summarizeTrajectory(events: TrajectoryEvent[], usage?: unknown): TrajectorySummary | null {
  if (!events.length) return null;
  const first = events[0]!;
  const last = events.at(-1)!;
  const usageSnapshot = [...events].reverse().find((event) => event.type === 'status' && event.details.usageMetrics)?.details.usageMetrics;
  const usageObject = usage && typeof usage === 'object'
    ? usage as Record<string, unknown>
    : usageSnapshot && typeof usageSnapshot === 'object'
      ? usageSnapshot as Record<string, unknown>
      : undefined;
  const modelMetrics = usageObject?.modelMetrics;
  const totalNanoAiu = typeof usageObject?.totalNanoAiu === 'number' ? usageObject.totalNanoAiu : undefined;
  const totalPremiumRequestCost = typeof usageObject?.totalPremiumRequestCost === 'number'
    ? usageObject.totalPremiumRequestCost
    : undefined;
  const model = [...events].reverse().find((event) => event.model)?.model;
  const inputTokens = typeof usageObject?.inputTokens === 'number'
    ? usageObject.inputTokens
    : events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0);
  const outputTokens = typeof usageObject?.outputTokens === 'number'
    ? usageObject.outputTokens
    : events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0);
  const models: TrajectorySummary['models'] = {};
  if (modelMetrics && typeof modelMetrics === 'object') {
    for (const [name, raw] of Object.entries(modelMetrics as Record<string, unknown>)) {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const usageBlock = item.usage && typeof item.usage === 'object' ? item.usage as Record<string, unknown> : {};
      models[name] = {
        inputTokens: typeof usageBlock.inputTokens === 'number' ? usageBlock.inputTokens : 0,
        outputTokens: typeof usageBlock.outputTokens === 'number' ? usageBlock.outputTokens : 0,
        ...(typeof item.totalNanoAiu === 'number' ? { totalNanoAiu: item.totalNanoAiu } : {}),
      };
    }
  }
  const finishedAt = last.type === 'turn_end' ? last.timestamp : undefined;
  return TrajectorySummarySchema.parse({
    turnId: first.turnId,
    startedAt: first.timestamp,
    ...(finishedAt ? { finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(first.timestamp).getTime() } : {}),
    ...(model ? { model } : {}),
    inputTokens: totalFromUsage(usage, 'inputTokens', inputTokens),
    outputTokens: totalFromUsage(usage, 'outputTokens', outputTokens),
    totalTokens: totalFromUsage(usage, 'totalTokens', inputTokens + outputTokens),
    ...(totalNanoAiu !== undefined ? { totalNanoAiu } : {}),
    ...(totalPremiumRequestCost !== undefined ? { totalPremiumRequestCost } : {}),
    models,
    eventCount: events.length,
  });
}

function totalFromUsage(usage: unknown, field: 'inputTokens' | 'outputTokens' | 'totalTokens', fallback: number): number {
  if (!usage || typeof usage !== 'object') return fallback;
  const value = (usage as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : fallback;
}