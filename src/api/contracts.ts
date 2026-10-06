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
  required: z.boolean(),
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
  purpose: z.string().min(10),
  expectedResult: z.string().min(10),
  deliverableIds: z.array(z.string().min(1)).min(1).max(12),
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

export const JourneyStageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  status: z.enum(['completed', 'current', 'locked', 'future']),
  nodeType: z.enum(['task', 'review', 'end']),
}).strict();

export const JourneyRouteSchema = z.object({
  outcome: z.string().min(1),
  target: z.string().min(1),
  line: z.number().int().positive().optional(),
}).strict();

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

export const JourneyDefinitionSchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  nodes: z.array(JourneyNodeSchema).min(1),
}).strict();

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

export const JourneyDerivedStateSchema = z.object({
  workflowId: z.string().min(1),
  stages: z.array(JourneyStageSchema),
}).strict();

export const JourneyLayoutNodeSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

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
  data: z.unknown().optional(),
  usage: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();

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
  if (value.type === 'checkpoint' && !TrajectoryCheckpointDetailsSchema.safeParse(value.details).success) {
    ctx.addIssue({
      code: 'custom',
      path: ['details'],
      message: 'checkpoint event 的 details 不符合 Stage Checkpoint contract。',
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

export const TrajectoryResponseSchema = z.object({
  events: z.array(TrajectoryEventSchema),
  summary: TrajectorySummarySchema.nullable(),
  turns: z.array(TrajectoryTurnSummarySchema),
  conversationTurns: z.array(z.unknown()),
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

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), data: z.object({ turnId: z.string().min(1) }).strict() }).strict(),
  z.object({ event: z.literal('heartbeat'), data: z.object({ timestamp: z.string().datetime() }).strict() }).strict(),
  z.object({ event: z.literal('delta'), data: z.object({ delta: z.string() }).strict() }).strict(),
  z.object({ event: z.literal('reasoning'), data: z.object({ delta: z.string() }).strict() }).strict(),
  z.object({ event: z.literal('companion_note'), data: z.object({ note: z.string() }).strict() }).strict(),
  z.object({ event: z.literal('status'), data: z.object({ status: z.unknown() }).strict() }).strict(),
  z.object({ event: z.literal('checkpoint'), data: z.unknown() }),
  z.object({ event: z.literal('completed'), data: z.unknown() }),
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

export const ArtifactProvenanceSchema = z.object({
  missionFingerprint: z.string().min(1),
  scopeFingerprint: z.string().min(1),
  sourceRevision: z.string().min(1),
  artifactVersion: z.number().int().positive(),
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
  plan: ArchitectureAssessmentViewSchema.nullable(),
  path: z.string().nullable(),
}).strict();
export type ArchitectureAssessmentResponse = z.infer<typeof ArchitectureAssessmentResponseSchema>;

export const ReportArtifactStateSchema = z.object({
  status: z.enum(['missing', 'stale', 'current', 'blocked', 'error']),
  generatedAt: z.string().datetime().optional(),
  sourceRevision: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
  reviewStatus: z.enum(['pass', 'fail', 'unavailable']).optional(),
  markdown: z.string().optional(),
}).strict();
export type ReportArtifactState = z.infer<typeof ReportArtifactStateSchema>;
