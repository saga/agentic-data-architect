/**
 * Investigation 持久化和运行时配置 Schema。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import * as z from 'zod';
import { ClaimSchema, DiscoveryRunSchema, EvidenceRefSchema, FindingSchema, GraphifyRunMetadataSchema } from '../evidence/types.js';

/** Investigation 可选的工作路线；null 表示由 Agent 自主调查，不采用固定路线。 */
export const WorkflowIdSchema = z.enum([
  'legacy-modernization',
  'financial-ai-native-architecture',
  'data-architecture-assessment',
]);
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

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
export const JourneyRouteOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(400),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
}).strict();
export type JourneyRouteOption = z.infer<typeof JourneyRouteOptionSchema>;

/** 最近一次 Agent 生成的动态路线集合；旧 Workflow 地图仍然独立存在。 */
export const JourneyPlanSchema = z.object({
  version: z.literal(1),
  source: z.literal('agent'),
  generatedAt: z.string().min(1),
  turnId: z.string().min(1).optional(),
  routes: z.array(JourneyRouteOptionSchema).max(3),
}).strict();
export type JourneyPlan = z.infer<typeof JourneyPlanSchema>;

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
  /** 助手的人格 / Soul；影响用户可见表达，不改变工具权限、证据规则或 Workflow。 */
  personality: z.string().max(4000).default(
    '温柔、亲近、俏皮，偶尔带一点小小的调侃和撒娇。说话自然，有人的温度，但不要为了卖萌影响结论的准确性。'
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
