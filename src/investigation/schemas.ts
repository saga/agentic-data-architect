/**
 * Investigation 持久化和运行时配置 Schema。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import * as z from 'zod';
import { ClaimSchema, DiscoveryRunSchema, EvidenceRefSchema, FindingSchema } from '../evidence/types.js';

/** 当前 Session 使用的固定工作路线；普通聊天不需要专门流程时仍可沿用默认的 Legacy Modernization。 */
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

/** Investigation 的核心 context.json Schema；它是持久化状态的运行时边界。 */
export const WorkspaceContextSchema = z.object({
  schemaVersion: z.literal(3),
  name: z.string().min(1),
  userPrompt: z.string(),
  workflow: WorkflowIdSchema.default('legacy-modernization'),
  goal: z.string(),
  scope: z.array(z.string()),
  systems: z.array(z.string()),
  questions: z.array(z.string()),
  discoveryRuns: z.array(DiscoveryRunSchema),
  evidence: z.array(EvidenceRefSchema),
  claims: z.array(ClaimSchema),
  findings: z.array(FindingSchema),
  unknowns: z.array(z.string()),
  importantInformation: z.array(z.string()),
  inputs: z.array(WorkspaceInputSchema),
  copilotSessionId: z.string().optional(),
  copilotConfigurationVersion: z.number().int().positive().optional(),
  updatedAt: z.string().min(1),
}).strict();
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;

/** 创建新 Workspace 时允许传入的初始化字段 Schema。 */
export const WorkspaceSeedSchema = z.object({
  userPrompt: z.string().optional(),
  workflow: WorkflowIdSchema.optional(),
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

/** Investigation 选中的 Skill 及其版本/内容指纹。 */
export const SkillSettingSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  sourceHash: z.string().optional(),
}).strict();
export type SkillSetting = z.infer<typeof SkillSettingSchema>;

/** Research configuration 的持久化 Schema。 */
export const ControlResearchSchema = z.object({
  githubRepositories: z.array(z.string()),
  githubSearchMode: GitHubSearchModeSchema,
  keywords: z.array(z.string()),
  importantDocuments: z.array(ImportantDocumentRefSchema),
}).strict();
export type ControlResearch = z.infer<typeof ControlResearchSchema>;

/** Agent 侧 configuration 的持久化 Schema，包括 system prompt、Skills 和 MCP。 */
/** 平台内置能力的固定配置；用户不能通过 Investigation Agent 配置关闭它，但每个 turn 会记录版本。 */
export const PlatformCapabilitySettingSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  enabled: z.boolean(),
}).strict();
export type PlatformCapabilitySetting = z.infer<typeof PlatformCapabilitySettingSchema>;

/** Graphify 本轮运行环境快照，记录实际使用的工具和 graph 指纹。 */
export const GraphifyRunMetadataSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(['available', 'missing', 'disabled']),
  command: z.string().optional(),
  packageVersion: z.string().optional(),
  graphPath: z.string().optional(),
  graphHash: z.string().optional(),
  extractionMode: z.string().optional(),
  capturedAt: z.string().min(1),
}).strict();
export type GraphifyRunMetadata = z.infer<typeof GraphifyRunMetadataSchema>;

export const ControlAgentSchema = z.object({
  systemPrompt: z.object({
    version: z.number().int().positive(),
    content: z.string(),
  }).strict(),
  skills: z.array(SkillSettingSchema),
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
