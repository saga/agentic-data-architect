export const WorkflowIdSchema = z.enum(['legacy-modernization', 'financial-ai-native-architecture', 'data-architecture-assessment']);
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

import * as z from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
  details: z.unknown().optional(),
}).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SseCheckpointSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  confirmed: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  unknowns: z.array(z.string()),
  nextStep: z.string().optional(),
  turnId: z.string().optional(),
  execution: z.number().int().nonnegative().optional(),
}).strict();

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), data: z.object({ turnId: z.string().min(1) }).strict() }),
  z.object({ event: z.literal('heartbeat'), data: z.object({ timestamp: z.string().datetime() }).strict() }),
  z.object({ event: z.literal('status'), data: z.object({ status: z.string() }).strict() }),
  z.object({ event: z.literal('delta'), data: z.object({ delta: z.string() }).strict() }),
  z.object({ event: z.literal('reasoning'), data: z.object({ delta: z.string() }).strict() }),
  z.object({ event: z.literal('companion_note'), data: z.object({ note: z.string() }).strict() }),
  z.object({ event: z.literal('checkpoint'), data: SseCheckpointSchema }),
  z.object({ event: z.literal('completed'), data: z.record(z.string(), z.unknown()) }),
  z.object({ event: z.literal('error'), data: z.object({ code: z.string().optional(), error: z.string().min(1) }).strict() }),
]).strict();
export type SseEvent = z.infer<typeof SseEventSchema>;


export const ArtifactReviewViewSchema = z.object({
  artifactType: z.enum(['report', 'target_architecture', 'mapping', 'validation']),
  status: z.enum(['pass', 'fail']),
  availability: z.enum(['completed', 'unavailable']),
  score: z.number().int().min(0).max(100),
  summary: z.string().min(1),
  issues: z.array(z.object({
    category: z.enum(['goal_alignment','readability','conclusion','signal_noise','consistency','decision_usefulness']),
    severity: z.enum(['high','medium','low']),
    description: z.string().min(1),
    suggestion: z.string().min(1),
  }).strict()),
  reviewedAt: z.string().datetime(),
  artifactVersion: z.number().int().positive(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{24}$/),
}).strict();

export const ResultViewModelSchema = z.object({
  status: z.literal('available'),
  report: z.string(),
  review: ArtifactReviewViewSchema,
}).strict();
export type ResultViewModel = z.infer<typeof ResultViewModelSchema>;

const WorkflowExecutionContractSchema = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().nonnegative(),
  runId: z.string().min(1),
  currentNodeId: z.string().min(1),
  completedNodeIds: z.array(z.string()),
  status: z.enum(['active', 'waiting', 'completed']),
  pendingInteraction: z.object({
    id: z.string().min(1),
    nodeId: z.string().min(1),
    reason: z.string().min(1),
    requestedAt: z.string().datetime(),
  }).optional(),
}).strict();

export const WorkflowSnapshotSchema = z.object({
  workflowId: WorkflowIdSchema,
  source: z.enum(['base', 'custom']),
  baseWorkflowId: WorkflowIdSchema,
  version: z.number().int().nonnegative(),
  definition: z.unknown(),
  layout: z.unknown(),
  state: z.object({
    workflowId: z.string().min(1),
    stages: z.array(z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      objective: z.string().min(1),
      status: z.enum(['completed', 'current', 'locked', 'future']),
      nodeType: z.enum(['task', 'review', 'end']),
    }).strict()),
    execution: WorkflowExecutionContractSchema,
  }).strict(),
  events: z.array(z.record(z.string(), z.unknown())),
}).strict();
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;


export const MissionDeliverableProgressSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
  status: z.enum(['covered', 'in_progress', 'not_started', 'not_tracked']),
  detail: z.string().min(1),
}).strict();

export const MissionProgressSchema = z.object({
  covered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
  deliverables: z.array(MissionDeliverableProgressSchema),
}).strict();
export type MissionProgressContract = z.infer<typeof MissionProgressSchema>;

export const MissionDeliverableContractSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  required: z.boolean(),
}).strict();

export const MissionContractApiSchema = z.object({
  version: z.literal(1),
  purpose: z.string().trim().min(10).max(2000),
  expectedResult: z.string().trim().min(10).max(4000),
  deliverables: z.array(MissionDeliverableContractSchema).min(1).max(12),
  status: z.literal('confirmed'),
  confirmedAt: z.string().datetime(),
  confirmedBy: z.literal('user'),
}).strict();
export type MissionContractApi = z.infer<typeof MissionContractApiSchema>;
