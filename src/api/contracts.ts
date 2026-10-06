/**
 * Browser-safe API contracts shared by server and web.
 *
 * This module must not import domain, filesystem, Node runtime, or server-only code.
 */
import * as z from 'zod';

export const WorkflowIdSchema = z.enum([
  'legacy-modernization',
  'financial-ai-native-architecture',
  'data-architecture-assessment',
]);
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const WorkProductStatusSchema = z.enum(['draft', 'in_review', 'approved', 'rejected']);
export type WorkProductStatus = z.infer<typeof WorkProductStatusSchema>;

export const MappingStatusSchema = z.enum(['proposed', 'reviewed', 'approved', 'rejected']);
export const ValidationStatusSchema = z.enum(['planned', 'ready', 'passed', 'failed', 'blocked']);
export const FindingSeveritySchema = z.enum(['info', 'low', 'medium', 'high']);

export const MissionDeliverableSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  required: z.boolean().default(true),
}).strict();
export type MissionDeliverable = z.infer<typeof MissionDeliverableSchema>;

export const MissionContractSchema = z.object({
  version: z.literal(1),
  purpose: z.string().min(10),
  expectedResult: z.string().min(10),
  deliverables: z.array(MissionDeliverableSchema).min(1).max(12),
  status: z.literal('confirmed'),
  confirmedAt: z.string().datetime(),
  confirmedBy: z.literal('user'),
}).strict();
export type MissionContract = z.infer<typeof MissionContractSchema>;

export const MissionDraftSchema = z.object({
  purpose: z.string().trim().min(1).max(2000),
  expectedResult: z.string().trim().min(1).max(4000),
  deliverableIds: z.array(z.string().trim().min(1).max(80)).max(12),
}).strict();
export type MissionDraft = z.infer<typeof MissionDraftSchema>;

export const MissionDeliverableStatusSchema = z.enum([
  'covered',
  'in_progress',
  'not_started',
  'not_tracked',
]);
export type MissionDeliverableStatus = z.infer<typeof MissionDeliverableStatusSchema>;

export const MissionDeliverableProgressSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
  status: MissionDeliverableStatusSchema,
  detail: z.string(),
}).strict();
export type MissionDeliverableProgress = z.infer<typeof MissionDeliverableProgressSchema>;

export const MissionProgressSchema = z.object({
  covered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
  deliverables: z.array(MissionDeliverableProgressSchema),
}).strict();
export type MissionProgress = z.infer<typeof MissionProgressSchema>;

export const JourneyNodeTypeSchema = z.enum(['task', 'review', 'end']);
export type JourneyNodeType = z.infer<typeof JourneyNodeTypeSchema>;
export const JourneyActorSchema = z.enum(['agent', 'human']);
export type JourneyActor = z.infer<typeof JourneyActorSchema>;

export const JourneyRouteOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(400),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
}).strict();
export type JourneyRouteOption = z.infer<typeof JourneyRouteOptionSchema>;

export const JourneyPlanSchema = z.object({
  version: z.literal(1),
  source: z.literal('agent'),
  generatedAt: z.string().datetime(),
  turnId: z.string().min(1).optional(),
  routes: z.array(JourneyRouteOptionSchema).max(3),
}).strict();
export type JourneyPlan = z.infer<typeof JourneyPlanSchema>;

export const JourneyStageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(['completed', 'current', 'locked', 'future']),
  nodeType: z.enum(['task', 'review', 'end']),
}).strict();
export type JourneyStage = z.infer<typeof JourneyStageSchema>;

export const JourneyRouteSchema = z.object({
  outcome: z.string().min(1),
  target: z.string().min(1),
  line: z.number().int().positive().optional(),
}).strict();
export type JourneyRoute = z.infer<typeof JourneyRouteSchema>;

export const JourneyNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['task', 'review', 'end']),
  title: z.string().min(1),
  objective: z.string().optional(),
  actor: z.enum(['agent', 'human']).default('agent'),
  completeWhen: z.string().optional(),
  routes: z.array(JourneyRouteSchema),
  line: z.number().int().positive().optional(),
}).strict();
export type JourneyNode = z.infer<typeof JourneyNodeSchema>;

export const JourneyDefinitionSchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  nodes: z.array(JourneyNodeSchema).min(1),
}).strict();
export type JourneyDefinition = z.infer<typeof JourneyDefinitionSchema>;

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
      type: JourneyNodeTypeSchema.optional(),
      title: z.string().min(1).optional(),
      objective: z.string().optional(),
      actor: JourneyActorSchema.optional(),
      completeWhen: z.string().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('remove-node'),
    nodeId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('add-route'),
    nodeId: z.string().min(1),
    route: JourneyRouteSchema,
  }).strict(),
  z.object({
    type: z.literal('update-route'),
    nodeId: z.string().min(1),
    outcome: z.string().min(1),
    patch: z.object({ target: z.string().min(1).optional() }).strict(),
  }).strict(),
  z.object({
    type: z.literal('remove-route'),
    nodeId: z.string().min(1),
    outcome: z.string().min(1),
  }).strict(),
]);
export type JourneyWorkflowChange = z.infer<typeof JourneyWorkflowChangeSchema>;
export const JourneyWorkflowChangesSchema = z.array(JourneyWorkflowChangeSchema).min(1).max(60);

export const JourneyExecutionSchema = z.object({
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
export type JourneyExecution = z.infer<typeof JourneyExecutionSchema>;

export const JourneyDerivedStateSchema = z.object({
  workflowId: z.string().min(1),
  stages: z.array(JourneyStageSchema),
}).strict();
export type JourneyDerivedState = z.infer<typeof JourneyDerivedStateSchema>;

export const JourneyLayoutNodeSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
export type JourneyLayoutNode = z.infer<typeof JourneyLayoutNodeSchema>;

export const JourneyLayoutSchema = z.object({
  version: z.literal(1),
  nodes: z.record(z.string(), JourneyLayoutNodeSchema),
  engine: z.enum(['workflow-v1', 'workflow-v2']).optional(),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  }).optional(),
}).strict();
export type JourneyLayout = z.infer<typeof JourneyLayoutSchema>;

export const JourneyRunDeterministicDataSchema = z.object({
  deterministic: z.literal(true),
}).strict();

export const JourneyRunNodeCompletedDataSchema = z.object({
  nextNodeId: z.string().min(1),
}).strict();

export const JourneyRunNodeWaitingDataSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  requestedAt: z.string().datetime(),
  deterministic: z.literal(true).optional(),
}).strict();

export const JourneyRunEventDataSchema = z.union([
  JourneyRunDeterministicDataSchema,
  JourneyRunNodeCompletedDataSchema,
  JourneyRunNodeWaitingDataSchema,
]);

export const JourneyRunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().nonnegative(),
  type: z.enum([
    'workflow-started',
    'node-started',
    'node-completed',
    'node-waiting',
    'node-failed',
    'workflow-completed',
    'transition-rejected',
  ]),
  timestamp: z.string().datetime(),
  nodeId: z.string().optional(),
  outcome: z.string().optional(),
  error: z.string().optional(),
  data: JourneyRunEventDataSchema.optional(),
  usage: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();
export type JourneyRunEvent = z.infer<typeof JourneyRunEventSchema>;

export const WorkflowSnapshotSchema = z.object({
  workflowId: WorkflowIdSchema,
  source: z.enum(['base', 'custom']),
  baseWorkflowId: WorkflowIdSchema,
  version: z.number().int().nonnegative(),
  definition: JourneyDefinitionSchema,
  layout: JourneyLayoutSchema,
  execution: JourneyExecutionSchema,
  state: JourneyDerivedStateSchema,
  events: z.array(JourneyRunEventSchema),
}).strict();
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

export const TrajectoryCheckpointDetailsSchema = z.object({
  execution: z.number().int().nonnegative(),
  title: z.string().min(1),
  summary: z.string().min(1),
  confirmed: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  unknowns: z.array(z.string()),
  nextStep: z.string().optional(),
}).strict();

export const TrajectoryTurnUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  totalNanoAiu: z.number().nonnegative().optional(),
  totalPremiumRequestCost: z.number().nonnegative().optional(),
  modelMetrics: z.record(z.string(), z.object({
    usage: z.object({
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
    }).strict().optional(),
    totalNanoAiu: z.number().nonnegative().optional(),
  }).strict()).optional(),
}).strict();

export const TrajectoryModelCallDetailsSchema = z.object({
  cachedInputTokens: z.number().nonnegative().optional(),
  newInputTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  availableToolCount: z.number().int().nonnegative().optional(),
  finishReason: z.string().optional(),
  reasoningEffort: z.string().optional(),
  timeToFirstTokenMs: z.number().nonnegative().optional(),
  interTokenLatencyMs: z.number().nonnegative().optional(),
  apiEndpoint: z.string().optional(),
  apiCallId: z.string().optional(),
  providerCallId: z.string().optional(),
  serviceRequestId: z.string().optional(),
  initiator: z.string().optional(),
  contextTokensAtCall: z.number().nonnegative().optional(),
  contextTokenLimitAtCall: z.number().int().nonnegative().optional(),
  contextPercentAtCall: z.number().min(0).max(100).optional(),
  contextMessagesAtCall: z.number().int().nonnegative().optional(),
}).strict();

export const TrajectoryToolCallDetailsSchema = z.object({
  toolCallId: z.string().min(1),
  startedAt: z.string().datetime(),
  mcpServerName: z.string().optional(),
  mcpToolName: z.string().optional(),
  parentToolCallId: z.string().optional(),
  agentId: z.string().optional(),
  arguments: z.unknown().optional(),
}).strict();

export const TrajectoryToolProgressDetailsSchema = z.object({
  toolCallId: z.string().min(1),
  progressMessage: z.unknown().optional(),
}).strict();

export const TrajectoryToolResultDetailsSchema = z.object({
  toolCallId: z.string().min(1),
  model: z.string().optional(),
  isUserRequested: z.boolean().optional(),
  parentToolCallId: z.string().optional(),
  resultPreview: z.string().optional(),
  resultLength: z.number().int().nonnegative().optional(),
  detailedResultLength: z.number().int().nonnegative().optional(),
  error: z.unknown().optional(),
}).strict();

export const TrajectoryUserInputRequestedDetailsSchema = z.object({
  requestId: z.string().min(1),
  question: z.string().min(1),
  choices: z.array(z.string()).optional(),
  allowFreeform: z.boolean().optional(),
}).strict();

export const TrajectoryUserInputCompletedDetailsSchema = z.object({
  requestId: z.string().min(1),
  question: z.string().optional(),
  answer: z.string().optional(),
  wasFreeform: z.boolean().optional(),
}).strict();

export const TrajectoryPermissionDetailsSchema = z.object({
  requestId: z.string().min(1),
  kind: z.string().min(1),
  toolCallId: z.string().optional(),
  intention: z.string().optional(),
  fullCommandText: z.string().optional(),
  fileName: z.string().optional(),
  path: z.string().optional(),
  serverName: z.string().optional(),
  toolName: z.string().optional(),
  toolTitle: z.string().optional(),
  readOnly: z.boolean().optional(),
  managedApprovalRequired: z.boolean().optional(),
}).strict();

export const TrajectoryPermissionCompletedDetailsSchema = z.object({
  requestId: z.string().min(1),
  kind: z.string().optional(),
  summary: z.string().optional(),
  resultKind: z.string().optional(),
}).strict();

export const TrajectoryIntentDetailsSchema = z.object({
  intent: z.string().min(1),
  mappedStatus: z.string().min(1),
}).strict();

export const TrajectoryTurnEndDetailsSchema = z.object({
  turnUsage: TrajectoryTurnUsageSchema.optional(),
  elapsedMs: z.number().nonnegative().optional(),
  modelCallCount: z.number().int().nonnegative().optional(),
  sessionIdleObserved: z.boolean().optional(),
}).strict();

export const TrajectorySessionIdleDetailsSchema = z.object({
  aborted: z.boolean(),
  pendingTools: z.number().int().nonnegative(),
  pendingPermissions: z.number().int().nonnegative(),
  pendingUserInputs: z.number().int().nonnegative(),
}).strict();

export const TrajectorySessionErrorDetailsSchema = z.object({
  errorType: z.string().optional(),
  message: z.string().optional(),
  statusCode: z.number().int().nonnegative().optional(),
  providerCallId: z.string().optional(),
}).strict();

export const TrajectoryContextChangedDetailsSchema = z.object({
  cwd: z.string(),
  gitRoot: z.string().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
}).strict();

export const TrajectoryCompactionDetailsSchema = z.object({
  preCompactionTokens: z.number().nonnegative().optional(),
  postCompactionTokens: z.number().nonnegative().optional(),
  messagesRemoved: z.number().int().nonnegative().optional(),
  tokensRemoved: z.number().nonnegative().optional(),
  compactionTokensUsed: z.unknown().optional(),
  requestId: z.string().optional(),
  error: z.string().optional(),
}).strict();

export const TrajectoryErrorDetailsSchema = z.object({
  error: z.string(),
  elapsedMs: z.number().nonnegative().optional(),
  timeoutMs: z.number().nonnegative().optional(),
  permissionWaitTimeoutMs: z.number().nonnegative().optional(),
  userInputWaitTimeoutMs: z.number().nonnegative().optional(),
  timeoutKind: z.enum(['permission', 'user_input', 'session_idle', 'execution']).optional(),
  lastActivityAt: z.string().optional(),
  lastActivityType: z.string().optional(),
  lastActivity: z.string().optional(),
  pendingTools: z.number().int().nonnegative(),
  pendingPermissions: z.number().int().nonnegative(),
  pendingUserInputs: z.number().int().nonnegative(),
  assistantTurnEnded: z.boolean(),
  sessionIdleObserved: z.boolean(),
  modelCallCount: z.number().int().nonnegative(),
  permissions: z.array(z.object({
    requestId: z.string().min(1),
    kind: z.string().min(1),
    requestedAt: z.string().datetime(),
    summary: z.string(),
  }).strict()).optional(),
}).strict();

export const TrajectoryStageGateDetailsSchema = z.object({
  execution: z.number().int().nonnegative(),
  passed: z.boolean(),
  checks: z.array(z.object({
    name: z.string().min(1),
    passed: z.boolean(),
    detail: z.string(),
  }).strict()),
  newEvidenceIds: z.array(z.string()),
  newFindingIds: z.array(z.string()),
  advancedDeliverables: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  }).strict()),
  evidenceBackedClaimCount: z.number().int().nonnegative(),
  shouldContinue: z.boolean(),
  missionAlignment: z.unknown().optional(),
  missionProgress: MissionProgressSchema.optional(),
  input: z.unknown().optional(),
}).strict();

export const TrajectoryEventSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  timestamp: z.string().datetime(),
  type: z.enum([
    'user_input','turn_start','assistant_turn_start','assistant_turn_end','intent',
    'model_call','tool_call','tool_result','tool_progress','permission',
    'permission_completed','user_input_requested','user_input_completed','compaction',
    'session_idle','session_error','context_changed','turn_end','error','checkpoint',
    'stage_gate','status',
  ]),
  name: z.string().min(1),
  status: z.enum(['started','completed','failed','waiting','info']).optional(),
  durationMs: z.number().nonnegative().optional(),
  model: z.string().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  premiumRequestCost: z.number().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  const schemas: Partial<Record<TrajectoryEvent['type'], z.ZodType>> = {
    checkpoint: TrajectoryCheckpointDetailsSchema,
    model_call: TrajectoryModelCallDetailsSchema,
    tool_call: TrajectoryToolCallDetailsSchema,
    tool_progress: TrajectoryToolProgressDetailsSchema,
    tool_result: TrajectoryToolResultDetailsSchema,
    user_input_requested: TrajectoryUserInputRequestedDetailsSchema,
    user_input_completed: TrajectoryUserInputCompletedDetailsSchema,
    permission: TrajectoryPermissionDetailsSchema,
    permission_completed: TrajectoryPermissionCompletedDetailsSchema,
    intent: TrajectoryIntentDetailsSchema,
    compaction: TrajectoryCompactionDetailsSchema,
    session_idle: TrajectorySessionIdleDetailsSchema,
    session_error: TrajectorySessionErrorDetailsSchema,
    context_changed: TrajectoryContextChangedDetailsSchema,
    turn_end: TrajectoryTurnEndDetailsSchema,
    error: TrajectoryErrorDetailsSchema,
    stage_gate: TrajectoryStageGateDetailsSchema,
  };
  const schema = schemas[value.type];
  if (schema && !schema.safeParse(value.details).success) {
    ctx.addIssue({
      code: 'custom',
      path: ['details'],
      message: value.type + ' event 的 nested details 不符合 Runtime Contract。',
    });
  }
});
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;

export const TrajectoryCheckpointSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  timestamp: z.string().datetime(),
  execution: z.number().int().nonnegative(),
  title: z.string().min(1),
  summary: z.string().min(1),
  confirmed: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  unknowns: z.array(z.string()),
  nextStep: z.string().optional(),
}).strict();
export type TrajectoryCheckpoint = z.infer<typeof TrajectoryCheckpointSchema>;

export const TrajectorySummarySchema = z.object({
  turnId: z.string().optional(),
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
  }).strict()),
  eventCount: z.number().int().nonnegative().default(0),
  state: z.enum(['running', 'waiting', 'completed', 'failed', 'aborted']).default('running'),
  waitingOn: z.enum(['tool', 'permission', 'user_input', 'model', 'session']).optional(),
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

export const TrajectoryTurnSummarySchema = z.object({
  turnId: z.string().min(1),
  userQuestion: z.string().optional(),
  summary: TrajectorySummarySchema,
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  failedEvents: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
}).strict();

export const ConversationTurnSummarySchema = z.object({
  turnId: z.string().min(1),
  sessionName: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'aborted']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  question: z.string().optional(),
}).strict();
export type ConversationTurnSummary = z.infer<typeof ConversationTurnSummarySchema>;

export const TrajectoryResponseSchema = z.object({
  events: z.array(TrajectoryEventSchema),
  summary: TrajectorySummarySchema.nullable(),
  turns: z.array(TrajectoryTurnSummarySchema),
  conversationTurns: z.array(ConversationTurnSummarySchema),
}).strict();
export type TrajectoryResponse = z.infer<typeof TrajectoryResponseSchema>;

export const ExecutionStatusSchema = z.object({
  state: z.enum(['idle', 'running', 'waiting_permission', 'waiting_user_input', 'committing']),
  running: z.boolean(),
  turnId: z.string().nullable(),
  phase: z.enum(['executing', 'committing']).nullable(),
  startedAt: z.string().datetime().nullable().optional(),
  lastActivityAt: z.string().datetime().nullable().optional(),
  lastActivity: z.string().nullable().optional(),
  pendingPermissionCount: z.number().int().nonnegative(),
  pendingUserInputCount: z.number().int().nonnegative(),
}).strict();
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const CheckpointSchema = TrajectoryCheckpointSchema;
export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const AnswerSummarySchema = z.object({
  answer: z.string(),
  claimIds: z.array(z.string()),
  warnings: z.array(z.string()),
  unknowns: z.array(z.string()),
  followUpQuestions: z.array(z.string()),
  routeOptions: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    reason: z.string().min(1),
    steps: z.array(z.string().min(1)),
  }).strict()),
}).strict();
export type AnswerSummaryContract = z.infer<typeof AnswerSummarySchema>;

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), data: z.object({ turnId: z.string().min(1) }).strict() }).strict(),
  z.object({ event: z.literal('heartbeat'), data: z.object({ timestamp: z.string().datetime() }).strict() }).strict(),
  z.object({ event: z.literal('delta'), data: z.object({ delta: z.string() }).strict() }).strict(),
  z.object({ event: z.literal('reasoning'), data: z.object({ delta: z.string() }).strict() }).strict(),
  z.object({ event: z.literal('companion_note'), data: z.object({ note: z.string() }).strict() }).strict(),
  z.object({ event: z.literal('status'), data: z.object({ status: z.string().min(1) }).strict() }).strict(),
  z.object({ event: z.literal('checkpoint'), data: TrajectoryCheckpointSchema }),
  z.object({ event: z.literal('completed'), data: AnswerSummarySchema }),
  z.object({ event: z.literal('error'), data: z.object({ error: z.string() }).strict() }).strict(),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;

export const InvestigationControlSchema = z.object({
  schemaVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  updatedAt: z.string().min(1),
  research: z.object({
    githubRepositories: z.array(z.string()),
    githubSearchMode: z.enum(['only_selected', 'selected_and_broad']),
    keywords: z.array(z.string()),
    importantDocuments: z.array(z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      reference: z.string().min(1),
    }).strict()),
  }).strict(),
  agent: z.object({
    model: z.string().min(1),
    autoTier: z.enum(['efficiency', 'balance', 'intelligence', 'fast']).optional(),
    permissionMode: z.enum(['permission', 'allow_all']),
    autoContinuationTurns: z.number().int().min(0).max(6),
    displayName: z.string().min(1),
    personality: z.string(),
    avatarPath: z.string().optional(),
    avatarPaths: z.array(z.string()).optional(),
    avatarMimeType: z.string().optional(),
    avatarSources: z.array(z.object({
      src: z.string().min(1),
      kind: z.enum(['image', 'video', 'remote']),
      mimeType: z.string().optional(),
    }).strict()).optional(),
    avatarWidth: z.number().int().positive(),
    avatarHeight: z.number().int().positive(),
    systemPrompt: z.object({ version: z.number().int().positive(), content: z.string() }).strict(),
    mcpServers: z.array(z.object({
      name: z.string().min(1),
      version: z.number().int().positive(),
      enabled: z.boolean(),
      type: z.enum(['local', 'http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      tools: z.array(z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }).strict()),
    platformCapabilities: z.array(z.object({
      name: z.string().min(1),
      version: z.number().int().positive(),
      enabled: z.boolean(),
    }).strict()).default([]),
  }).strict(),
  history: z.array(z.object({
    version: z.number().int().positive(),
    updatedAt: z.string().min(1),
    reason: z.string(),
  }).strict()),
}).strict();
export type InvestigationControl = z.infer<typeof InvestigationControlSchema>;

export const ArtifactLifecycleStatusSchema = z.enum(['missing', 'stale', 'current', 'blocked', 'error']);
export type ArtifactLifecycleStatus = z.infer<typeof ArtifactLifecycleStatusSchema>;

export const ArtifactProvenanceSchema = z.object({
  missionFingerprint: z.string().min(1),
  scopeFingerprint: z.string().min(1),
  sourceRevision: z.string().min(1),
  artifactVersion: z.number().int().positive(),
  discoveryRunId: z.string().min(1).optional(),
  discoveryScopeFingerprint: z.string().min(1).optional(),
}).strict();
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const ModernizationPlanViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: WorkProductStatusSchema,
  version: z.number().int().positive(),
  generatedAt: z.string().min(1),
  goal: z.string(),
  scope: z.array(z.string()),
  currentState: z.object({
    datasets: z.number().int().nonnegative(),
    lineageCoverage: z.number().min(0).max(1).nullable(),
    parseFailures: z.number().int().nonnegative(),
    semanticAssets: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
  }).strict(),
  targetArchitecture: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: WorkProductStatusSchema,
    principles: z.array(z.string()),
    components: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
      sourceAssets: z.array(z.string()),
    }).strict()),
    openQuestions: z.array(z.string()),
    evidenceIds: z.array(z.string()),
    findingIds: z.array(z.string()),
    decisionIds: z.array(z.string()),
    type: z.literal('target_architecture'),
    version: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }).strict(),
  mappings: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: MappingStatusSchema,
    sourceAsset: z.string().min(1),
    targetAsset: z.string().min(1),
    transformation: z.string().optional(),
    businessRule: z.string().optional(),
    validationRule: z.string().optional(),
    evidenceIds: z.array(z.string()),
    findingIds: z.array(z.string()),
    decisionIds: z.array(z.string()),
    type: z.literal('source_to_target'),
    version: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  }).strict()),
  mappingCoverage: z.object({
    sourceAssets: z.array(z.string()),
    unmappedAssets: z.array(z.string()),
  }).strict().optional(),
  validationPlan: z.object({
    id: z.string().min(1),
    type: z.literal('modernization_plan'),
    title: z.string().min(1),
    status: WorkProductStatusSchema,
    version: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    evidenceIds: z.array(z.string()),
    findingIds: z.array(z.string()),
    decisionIds: z.array(z.string()),
    scope: z.array(z.string()),
    checks: z.array(z.object({
      id: z.string().min(1),
      type: z.enum(['coverage','lineage','semantic','mapping','reconciliation','quality','cutover']),
      name: z.string().min(1),
      description: z.string().min(1),
      status: ValidationStatusSchema,
      blocking: z.boolean(),
      evidenceIds: z.array(z.string()),
      result: z.string().optional(),
    }).strict()),
    cutoverCriteria: z.array(z.string()),
    rollbackCriteria: z.array(z.string()),
  }).strict(),
  provenance: ArtifactProvenanceSchema.optional(),
}).strict();
export type ModernizationPlanView = z.infer<typeof ModernizationPlanViewSchema>;

export const ModernizationResponseSchema = z.object({
  status: ArtifactLifecycleStatusSchema,
  plan: ModernizationPlanViewSchema.nullable(),
  path: z.string().nullable(),
}).strict();
export type ModernizationResponse = z.infer<typeof ModernizationResponseSchema>;

export const ArchitectureAssessmentViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['draft', 'reviewed']),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  goal: z.string(),
  scope: z.array(z.string()),
  currentState: z.object({
    datasets: z.number().int().nonnegative(),
    lineageCoverage: z.number().min(0).max(1).nullable(),
    semanticAssets: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    unknowns: z.number().int().nonnegative(),
  }).strict(),
  findings: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: FindingSeveritySchema,
    description: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceIds: z.array(z.string()),
  }).strict()),
  recommendations: z.array(z.string()),
  roadmap: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    objective: z.string().min(1),
    findingIds: z.array(z.string()),
  }).strict()),
  evidenceIds: z.array(z.string()),
  provenance: ArtifactProvenanceSchema.optional(),
}).strict();
export type ArchitectureAssessmentView = z.infer<typeof ArchitectureAssessmentViewSchema>;

export const ArchitectureAssessmentResponseSchema = z.object({
  status: ArtifactLifecycleStatusSchema,
  plan: ArchitectureAssessmentViewSchema.nullable(),
  path: z.string().nullable(),
}).strict();
export type ArchitectureAssessmentResponse = z.infer<typeof ArchitectureAssessmentResponseSchema>;

export const ReviewIssueSchema = z.object({
  category: z.enum([
    'goal_alignment',
    'readability',
    'conclusion',
    'signal_noise',
    'consistency',
    'decision_usefulness',
  ]),
  severity: z.enum(['high', 'medium', 'low']),
  description: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
}).strict();
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ReviewArtifactTypeSchema = z.enum(['report', 'target_architecture', 'mapping', 'validation']);
export type ReviewArtifactType = z.infer<typeof ReviewArtifactTypeSchema>;

export const ArtifactReviewContractSchema = z.object({
  artifactType: ReviewArtifactTypeSchema,
  status: z.enum(['pass', 'fail']),
  availability: z.enum(['completed', 'unavailable']).default('completed'),
  score: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1),
  issues: z.array(ReviewIssueSchema),
  reviewedAt: z.string().datetime(),
  artifactHash: z.string().min(1).optional(),
  sourceRevision: z.string().min(1).optional(),
  artifactVersion: z.number().int().positive().optional(),
}).strict();
export type ArtifactReviewContract = z.infer<typeof ArtifactReviewContractSchema>;

export const ReportArtifactStateSchema = z.object({
  status: ArtifactLifecycleStatusSchema,
  generatedAt: z.string().datetime().optional(),
  sourceRevision: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
  reviewStatus: z.enum(['pass', 'fail', 'unavailable']).optional(),
  markdown: z.string().optional(),
}).strict();
export type ReportArtifactState = z.infer<typeof ReportArtifactStateSchema>;


/** Session / workspace API projections. Domain internals remain server-owned. */
export const SessionSummarySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  userPrompt: z.string(),
  updatedAt: z.string().min(1),
}).strict();
export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
}).strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  actor: z.enum(['user', 'system']),
  action: z.string().min(1),
  summary: z.string().min(1),
  configurationVersion: z.number().int().positive().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  capturedAt: z.string().datetime(),
}).strict();

export type Message = z.infer<typeof MessageSchema>;

export const WorkspaceInputViewSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  capturedAt: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  source: z.string().optional(),
  uri: z.string().optional(),
  artifactPath: z.string().optional(),
  important: z.boolean().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
}).strict();
export type WorkspaceInputView = z.infer<typeof WorkspaceInputViewSchema>;

export const CurrentStateViewSchema = CurrentStateSummarySchema;

export const SessionContextViewSchema = z.object({
  name: z.string().min(1),
  mission: MissionContractSchema.optional(),
  workflow: WorkflowIdSchema.nullable(),
  userPrompt: z.string(),
  goal: z.string(),
  scope: z.array(z.string()),
  systems: z.array(z.string()),
  evidence: z.array(z.unknown()),
  findings: z.array(z.unknown()),
  unknowns: z.array(z.string()),
  claims: z.array(z.unknown()),
  inputs: z.array(WorkspaceInputViewSchema),
  journeyPlan: JourneyPlanSchema.optional(),
  updatedAt: z.string().min(1),
}).strict();
export type SessionContextView = z.infer<typeof SessionContextViewSchema>;

export const SessionDataSchema = z.object({
  context: SessionContextViewSchema,
  missionProgress: MissionProgressSchema.nullable(),
  control: InvestigationControlSchema,
  localDatasets: z.array(z.unknown()),
  recentAudit: z.array(AuditEventSchema),
  messages: z.array(MessageSchema),
  conversationCount: z.number().int().nonnegative(),
  conversationLastMessageAt: z.string().datetime().nullable(),
  currentState: CurrentStateViewSchema.nullable(),
  semanticAssets: z.array(z.unknown()),
}).strict();
export type SessionDataContract = z.infer<typeof SessionDataSchema>;

export const MissionGateCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().min(1),
}).strict();
export const MissionGateResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(MissionGateCheckSchema),
  draft: MissionDraftSchema,
}).strict();

export const MissionResponseSchema = z.object({
  mission: MissionContractSchema.nullable(),
  gate: MissionGateResultSchema,
  progress: MissionProgressSchema.nullable(),
  draft: MissionDraftSchema.optional(),
}).strict();

export type CopilotModelOption = z.infer<typeof CopilotModelOptionSchema>;
export const OpenCodeStatusSchema = z.object({
  enabled: z.boolean(),
  reachable: z.boolean(),
  baseUrl: z.string().min(1),
  modelCount: z.number().int().nonnegative(),
  error: z.string().optional(),
}).strict();
export type OpenCodeStatus = z.infer<typeof OpenCodeStatusSchema>;

export const CopilotModelOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  supportedReasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string().nullable(),
  policyState: z.string().nullable(),
  runtime: z.enum(['copilot', 'opencode']).optional(),
}).strict();

export type CopilotModelOption = z.infer<typeof CopilotModelOptionSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(CopilotModelOptionSchema),
}).strict();

export const PendingPermissionSchema = z.object({
  sessionName: z.string().min(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  kind: z.string().min(1),
  requestedAt: z.string().datetime(),
  intention: z.string().optional(),
  fullCommandText: z.string().optional(),
  fileName: z.string().optional(),
  path: z.string().optional(),
  serverName: z.string().optional(),
  toolName: z.string().optional(),
  toolTitle: z.string().optional(),
  readOnly: z.boolean().optional(),
  managedApprovalRequired: z.boolean().optional(),
}).strict();

export type PendingPermission = z.infer<typeof PendingPermissionSchema>;

export const PermissionsResponseSchema = z.object({
  permissions: z.array(PendingPermissionSchema),
}).strict();

export const PendingUserInputSchema = z.object({
  sessionName: z.string().min(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  question: z.string().min(1),
  choices: z.array(z.string()),
  allowFreeform: z.boolean(),
  requestedAt: z.string().datetime(),
}).strict();

export type PendingUserInput = z.infer<typeof PendingUserInputSchema>;

export const UserInputsResponseSchema = z.object({
  requests: z.array(PendingUserInputSchema),
}).strict();

export const AuditResponseSchema = z.object({
  events: z.array(AuditEventSchema),
}).strict();

export const MessagesResponseSchema = z.object({
  messages: z.array(MessageSchema),
  search: z.string().nullable(),
}).strict();

export const DatasetsResponseSchema = z.object({
  datasets: z.array(z.unknown()),
  engine: z.object({
    type: z.literal('duckdb'),
    databaseFile: z.string().min(1),
  }).strict(),
}).strict();

export const WorkflowCompatibilityJourneySchema = z.object({
  workflowId: WorkflowIdSchema,
  stages: z.array(JourneyStageSchema),
  execution: JourneyExecutionSchema,
}).strict();

export const WorkflowCompatibilityResponseSchema = z.object({
  journey: WorkflowCompatibilityJourneySchema.nullable(),
  routePlan: JourneyPlanSchema.nullable().optional(),
  workflow: z.object({
    source: z.enum(['base', 'custom']),
    baseWorkflowId: WorkflowIdSchema,
    version: z.number().int().nonnegative(),
  }).strict().optional(),
  error: z.string().optional(),
}).strict();

export const ReportRegenerateResponseSchema = z.object({
  markdown: z.string(),
  path: z.string().min(1),
  review: ArtifactReviewContractSchema,
}).strict();

export const ControlResponseSchema = z.object({
  control: InvestigationControlSchema,
}).strict();


export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string().min(1),
}).strict();

export const CreateSessionResponseSchema = z.object({
  context: SessionContextViewSchema,
}).strict();

export const MissionUpdateResponseSchema = z.object({
  context: SessionContextViewSchema,
  mission: MissionContractSchema,
  gate: MissionGateResultSchema,
  progress: MissionProgressSchema.nullable(),
}).strict();

export const WorkflowContextResponseSchema = z.object({
  context: SessionContextViewSchema,
}).strict();

export const FileUploadResponseSchema = z.object({
  input: WorkspaceInputViewSchema,
  file: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    mimeType: z.string().min(1),
    dataset: z.unknown().optional(),
  }).strict(),
}).strict();

export const WorkflowInstructionResponseSchema = z.string();

export const SimpleOkResponseSchema = z.object({
  ok: z.literal(true),
}).strict();

export const AbortResponseSchema = z.object({
  aborted: z.boolean(),
}).strict();

export const WorkflowSaveResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  snapshot: WorkflowSnapshotSchema,
}).strict();

export const WorkflowTransitionResponseSchema = z.object({
  applied: z.boolean(),
  error: z.string().optional(),
  execution: JourneyExecutionSchema.optional(),
  snapshot: WorkflowSnapshotSchema.optional(),
}).strict();

export const WorkflowResetResponseSchema = WorkflowSnapshotSchema;

export const JourneyAiResponseSchema = z.object({
  definition: JourneyDefinitionSchema,
  message: z.string().min(1),
  changes: JourneyWorkflowChangesSchema,
  summary: z.array(z.string()),
}).strict();
export type JourneyAiResponse = z.infer<typeof JourneyAiResponseSchema>;

export const ReportErrorResponseSchema = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
}).strict();

