/**
 * Investigation 持久化和运行时配置 Schema。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import * as z from 'zod';
import {
  JourneyPlanSchema as SharedJourneyPlanSchema,
  MissionContractSchema as SharedMissionContractSchema,
  MissionDeliverableSchema as SharedMissionDeliverableSchema,
  MissionDraftSchema as SharedMissionDraftSchema,
  WorkflowIdSchema as SharedWorkflowIdSchema,
  type JourneyPlan as SharedJourneyPlan,
  type MissionContract as SharedMissionContract,
  type MissionDeliverable as SharedMissionDeliverable,
  type MissionDraft as SharedMissionDraft,
  type WorkflowId as SharedWorkflowId,
} from '../api/contracts.js';
import { ClaimSchema, DiscoveryRunSchema, EvidenceRefSchema, FindingSchema, GraphifyRunMetadataSchema } from '../evidence/types.js';

/** 任务契约中的单个交付物；用于判断调查是否一直在朝用户最终结果推进。 */
export const MissionDeliverableSchema = SharedMissionDeliverableSchema;
export type MissionDeliverable = SharedMissionDeliverable;

/**
 * Investigation 的 Mission Contract。
 *
 * purpose = 为什么做；
 * expectedResult = 最后要拿到什么；
 * deliverables = 把期望结果拆成几个可观察的交付物。
 *
 * 只有用户明确确认后，Mission 才能进入 confirmed 状态。模型不能替用户确认 Mission。
 */
export const MissionContractSchema = SharedMissionContractSchema;
export type MissionContract = SharedMissionContract;

/** UI / API 展示的 Mission 草稿；草稿没有确认资格，也不能解除 Mission Gate。 */
export const MissionDraftSchema = SharedMissionDraftSchema;
export type MissionDraft = SharedMissionDraft;

/** Investigation 可选的工作路线；null 表示由 Agent 自主调查，不采用固定路线。 */
export const WorkflowIdSchema = SharedWorkflowIdSchema;
export type WorkflowId = SharedWorkflowId;

/** Agent execution runtime. The selected runtime is a task-level preference; fallback order is application configuration. */
export const AgentRuntimeSchema = z.enum(['codebuddy-sdk', 'copilot-sdk', 'opencode-run']);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

/** Workspace 输入事件的来源类型；用于区分用户、Agent、Discovery 和外部文档。 */
export const WorkspaceInputKindSchema = z.enum([
  'user_prompt', 'user_message', 'assistant_message', 'question',
  'discovery', 'research', 'decision', 'note', 'document',
]);
/** Workspace 输入的持久化 Schema。 */
export const WorkspaceInputSchema = z.object({
  id: z.string().min(1),
  kind: WorkspaceInputKindSchema,
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
export type WorkspaceInput = z.infer<typeof WorkspaceInputSchema>;

/** Agent 根据当前问题和证据生成的可选动态路线；它只是导引，不是强制执行的 Workflow。 */
export { JourneyRouteOptionSchema, type JourneyRouteOption } from '../api/contracts.js';

/** 最近一次 Agent 生成的动态路线集合；旧 Workflow 地图仍然独立存在。 */
export const JourneyPlanSchema = SharedJourneyPlanSchema;
export type JourneyPlan = SharedJourneyPlan;

/** 阶段性调查小结的持久化结构；是否生成由服务器 Stage Script Gate 决定，不由 Agent 自行宣布。 */
export const AgentCheckpointSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1200),
  confirmed: z.array(z.string().trim().min(1).max(500)).max(6).default([]),
  evidenceIds: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  unknowns: z.array(z.string().trim().min(1).max(500)).max(6).default([]),
  nextStep: z.string().trim().min(1).max(500).optional(),
}).strict();
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;

/** Agent 对这次调查范围的整理结果；只有完整且有来源的结果才能写入正式调查状态。 */
export const AgentIntakeSchema = z.object({
  goal: z.string().trim().min(1).optional(),
  scope: z.array(z.string().trim().min(1)).min(1).optional(),
  systems: z.array(z.string().trim().min(1)).min(1).optional(),
  /** user = 用户明确提供；materials = 材料明确支持；mixed = 两者共同支持。 */
  source: z.enum(['user', 'materials', 'mixed']).default('materials'),
  /** true 表示用户已经明确确认过这组范围；不是模型自己的判断。 */
  userConfirmed: z.boolean().default(false),
  evidenceIds: z.array(z.string().trim().min(1)).max(24).default([]),
}).strict();
export type AgentIntake = z.infer<typeof AgentIntakeSchema>;

/** 正式报告和 Workflow 使用的范围确认快照。字段变化后旧确认自动失效。 */
export const ScopeValidationSchema = z.object({
  status: z.literal('validated'),
  goal: z.string().trim().min(1),
  scope: z.array(z.string().trim().min(1)).min(1),
  systems: z.array(z.string().trim().min(1)).min(1),
  source: z.enum(['user', 'materials', 'mixed']),
  userConfirmed: z.boolean(),
  evidenceIds: z.array(z.string().trim().min(1)),
  /** Current Scope/Systems identity; legacy validations may omit it but cannot pass the formal Scope Gate. */
  scopeFingerprint: z.string().min(1).optional(),
  validatedAt: z.string().min(1),
}).strict();
export type ScopeValidation = z.infer<typeof ScopeValidationSchema>;

/** Investigation 的核心 context.json Schema；它是持久化状态的运行时边界。 */
export const WorkspaceContextSchema = z.object({
  schemaVersion: z.literal(3),
  name: z.string().min(1),
  userPrompt: z.string(),
  workflow: WorkflowIdSchema.nullable().default(null),
  goal: z.string(),
  scope: z.array(z.string()),
  systems: z.array(z.string()),
  /** 本次 Investigation 的最高优先级任务契约；没有 confirmed Mission 时不得开始 Agent 调查。 */
  mission: MissionContractSchema.optional(),
  /** 只有这里记录的 validated 快照仍与当前 goal/scope/systems 一致时，正式产物才能生成。 */
  scopeValidation: ScopeValidationSchema.optional(),
  questions: z.array(z.string()),
  discoveryRuns: z.array(DiscoveryRunSchema),
  evidence: z.array(EvidenceRefSchema),
  claims: z.array(ClaimSchema),
  findings: z.array(FindingSchema),
  unknowns: z.array(z.string()),
  importantInformation: z.array(z.string()),
  inputs: z.array(WorkspaceInputSchema),
  journeyPlan: JourneyPlanSchema.optional(),
  copilotSessionId: z.string().optional(),
  copilotConfigurationVersion: z.number().int().positive().optional(),
  updatedAt: z.string().min(1),
}).strict();
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;

/** 创建新 Workspace 时允许传入的初始化字段 Schema。 */
export const WorkspaceSeedSchema = z.object({
  userPrompt: z.string().optional(),
  workflow: WorkflowIdSchema.nullable().optional(),
  goal: z.string().optional(),
  scope: z.array(z.string()).optional(),
  systems: z.array(z.string()).optional(),
}).strict();
export type WorkspaceSeed = z.infer<typeof WorkspaceSeedSchema>;

/** Shared Artifact 来源类型枚举。 */
export const SharedArtifactKindSchema = z.enum([
  'confluence', 'github', 'leanix', 'web', 'document', 'other',
]);
/** shared/index.json 中单个 Artifact 的结构 Schema。 */
export const SharedArtifactIndexEntrySchema = z.object({
  id: z.string().min(1),
  kind: SharedArtifactKindSchema,
  path: z.string().min(1),
  title: z.string().min(1),
  source: z.string().optional(),
  uri: z.string().optional(),
  updatedAt: z.string().min(1),
  sessionNames: z.array(z.string()).optional(),
}).strict();
export type SharedArtifactIndexEntry = z.infer<typeof SharedArtifactIndexEntrySchema>;

/** 跨 Investigation 共享 Artifact 索引的完整 Schema。 */
export const SharedIndexSchema = z.object({
  schemaVersion: z.literal(1),
  artifacts: z.array(SharedArtifactIndexEntrySchema),
  updatedAt: z.string().min(1),
}).strict();
export type SharedIndex = z.infer<typeof SharedIndexSchema>;

/** GitHub 搜索范围策略。 */
export const GitHubSearchModeSchema = z.enum(['only_selected', 'selected_and_broad']);
export type GitHubSearchMode = z.infer<typeof GitHubSearchModeSchema>;

/** 用户指定的重要文档引用结构。 */
export const ImportantDocumentRefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  reference: z.string().min(1),
}).strict();
export type ImportantDocumentRef = z.infer<typeof ImportantDocumentRefSchema>;

/** Investigation 内一个 MCP Server 配置的运行时 Schema。 */
export const McpServerSettingSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  type: z.enum(['local', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  tools: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).strict();
export type McpServerSetting = z.infer<typeof McpServerSettingSchema>;

/** Research configuration 的持久化 Schema。 */
export const ControlResearchSchema = z.object({
  githubRepositories: z.array(z.string()),
  githubSearchMode: GitHubSearchModeSchema,
  keywords: z.array(z.string()),
  importantDocuments: z.array(ImportantDocumentRefSchema),
}).strict();
export type ControlResearch = z.infer<typeof ControlResearchSchema>;

/** Agent 侧 configuration 的持久化 Schema：本次调查说明、用户自配 MCP 和平台能力快照。 */
/** 平台内置能力的固定配置；用户不能通过 Investigation Agent 配置关闭它，但每个 turn 会记录版本。 */
export const PlatformCapabilitySettingSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  enabled: z.boolean(),
}).strict();
export type PlatformCapabilitySetting = z.infer<typeof PlatformCapabilitySettingSchema>;

export const ControlAgentSchema = z.object({
  /** 当前 Investigation 首选 Agent Runtime；quota 不足时由 runtime 层按配置顺序自动 fallback。 */
  runtime: AgentRuntimeSchema.default('codebuddy-sdk'),
  /** 每个 Investigation 当前使用的模型；默认由 Auto 自动选择。 */
  model: z.string().trim().min(1).max(200).default('auto'),
  /** Auto 模式下的路由偏好；不设置时使用 Copilot 当前默认选择。 */
  autoTier: z.enum(['efficiency', 'balance', 'intelligence', 'fast']).optional(),
  /** permission = 每次危险工具操作由前端确认；allow_all = 每次请求自动批准。 */
  permissionMode: z.enum(['permission', 'allow_all']).default('allow_all'),
  /** 本轮 Agent 自己认为阶段完成后，最多再自动推进多少阶段；0 表示不自动续跑。 */
  autoContinuationTurns: z.number().int().min(0).max(6).default(4),
  /** 对话中显示的助手名称；默认“秘书”，只影响展示和复制文本，不参与 Agent 推理。 */
  displayName: z.string().trim().min(1).max(40).default('秘书'),
  /** 助手的人格 / Soul；影响相处方式和判断风格，但不能覆盖 Mission、Evidence、权限或 Workflow。 */
  personality: z.string().max(4000).default(
    '长期陪伴用户工作的专业秘书。亲近、自然、有温度，但不油腻，不刻意卖萌；工作问题直接、清楚、克制，复杂问题保持耐心，轻松交流可以有一点自然的俏皮。保持稳定的身份和表达习惯，让长期相处有连续感，但不要虚构记忆、经历或关系。人格只影响表达方式，不决定任务判断。'
  ),
  /** 兼容旧版的单头像路径；新配置仍可使用 avatarPaths。 */
  avatarPath: z.string().trim().min(1).optional(),
  /** 本地头像文件列表；兼容旧版配置。 */
  avatarPaths: z.array(z.string().trim().min(1)).optional(),
  /** 头像来源；支持本地图片/GIF/视频，以及 HTTPS 远程 URL。 */
  avatarSources: z.array(z.object({
    src: z.string().trim().min(1).max(4000),
    kind: z.enum(['image', 'video', 'remote']).default('remote'),
    mimeType: z.string().trim().min(1).max(100).optional(),
  }).strict()).optional(),
  /** 旧版单一头像 MIME 类型。 */
  avatarMimeType: z.string().trim().min(1).max(100).optional(),
  /** 头像目标宽度；同时决定裁剪比例和最终图片像素宽度。 */
  avatarWidth: z.number().int().min(40).max(800).default(180),
  /** 头像目标高度；同时决定裁剪比例和最终图片像素高度。 */
  avatarHeight: z.number().int().min(40).max(1200).default(240),
  systemPrompt: z.object({
    version: z.number().int().positive(),
    content: z.string(),
  }).strict(),
  mcpServers: z.array(McpServerSettingSchema),
  platformCapabilities: z.array(PlatformCapabilitySettingSchema).default([]),
}).strict();
export type ControlAgent = z.infer<typeof ControlAgentSchema>;

/** Global Agent 配置：所有 Investigation 默认继承；不随单个任务迁移。 */
export const GlobalAgentConfigSchema = ControlAgentSchema;
export type GlobalAgentConfig = z.infer<typeof GlobalAgentConfigSchema>;

/** Task Agent override：只保存任务明确覆盖 Global 的字段。 */
type StripZodDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
const taskAgentOverrideShape = Object.fromEntries(
  Object.entries(ControlAgentSchema.shape).map(([key, field]) => [
    key,
    (field instanceof z.ZodDefault ? field.removeDefault() : field).optional(),
  ]),
) as {
  [K in keyof typeof ControlAgentSchema.shape]: z.ZodOptional<StripZodDefault<(typeof ControlAgentSchema.shape)[K]>>;
};
// 注意：不能直接用 ControlAgentSchema.partial()——zod 会保留 .default()，
// 稀疏 override 一 parse 就会长出 model:'auto' 之类的幽灵默认值，反过来压住
// Global 传下来的值（2026-10 实测）。这里逐字段去掉 default 才是真正的 sparse。
export const TaskAgentOverrideSchema = z.object(taskAgentOverrideShape).strict();
export type TaskAgentOverride = z.infer<typeof TaskAgentOverrideSchema>;

/** 全局配置文件；版本独立于任何 Investigation。 */
export const GlobalConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  updatedAt: z.string().min(1),
  agent: GlobalAgentConfigSchema,
}).strict();
export type GlobalConfiguration = z.infer<typeof GlobalConfigurationSchema>;

/** Task workspace 内持久化的配置：research 属于任务，agent 只保存 override。 */
export const TaskConfigurationSchema = z.object({
  schemaVersion: z.literal(2),
  version: z.number().int().positive(),
  globalVersion: z.number().int().positive(),
  updatedAt: z.string().min(1),
  research: ControlResearchSchema,
  agent: TaskAgentOverrideSchema,
  history: z.array(z.object({
    version: z.number().int().positive(),
    globalVersion: z.number().int().positive(),
    updatedAt: z.string().min(1),
    reason: z.string(),
    snapshot: z.object({
      research: ControlResearchSchema,
      agent: ControlAgentSchema,
    }).strict(),
  }).strict()),
}).strict();
export type TaskConfiguration = z.infer<typeof TaskConfigurationSchema>;

/** 不包含 history 的当前 Control 配置 Schema。 */
export const InvestigationControlBaseSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  updatedAt: z.string().min(1),
  research: ControlResearchSchema,
  agent: ControlAgentSchema,
}).strict();

const ControlHistoryEntrySchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.string().min(1),
  reason: z.string(),
  snapshot: InvestigationControlBaseSchema,
}).strict();

/** 完整 control.json Schema，包括配置历史。 */
export const InvestigationControlSchema = InvestigationControlBaseSchema.extend({
  history: z.array(ControlHistoryEntrySchema),
}).strict();
export type InvestigationControl = z.infer<typeof InvestigationControlSchema>;

/** audit.jsonl 单条审计事件的 Schema。 */
export const AuditEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  actor: z.enum(['user', 'system']),
  action: z.string().min(1),
  summary: z.string().min(1),
  configurationVersion: z.number().int().positive().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
