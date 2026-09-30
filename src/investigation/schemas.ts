import * as z from 'zod';
import { ClaimSchema, DiscoveryRunSchema, EvidenceRefSchema, FindingSchema } from '../evidence/types.js';

export const WorkspaceInputKindSchema = z.enum([
  'user_prompt', 'user_message', 'assistant_message', 'question',
  'discovery', 'research', 'decision', 'note', 'document',
]);
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

export const WorkspaceContextSchema = z.object({
  schemaVersion: z.literal(3),
  name: z.string().min(1),
  userPrompt: z.string(),
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

export const WorkspaceSeedSchema = z.object({
  userPrompt: z.string().optional(),
  goal: z.string().optional(),
  scope: z.array(z.string()).optional(),
  systems: z.array(z.string()).optional(),
}).strict();
export type WorkspaceSeed = z.infer<typeof WorkspaceSeedSchema>;

export const SharedArtifactKindSchema = z.enum([
  'confluence', 'github', 'leanix', 'web', 'document', 'other',
]);
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

export const SharedIndexSchema = z.object({
  schemaVersion: z.literal(1),
  artifacts: z.array(SharedArtifactIndexEntrySchema),
  updatedAt: z.string().min(1),
}).strict();
export type SharedIndex = z.infer<typeof SharedIndexSchema>;

export const GitHubSearchModeSchema = z.enum(['only_selected', 'selected_and_broad']);
export type GitHubSearchMode = z.infer<typeof GitHubSearchModeSchema>;

export const ImportantDocumentRefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  reference: z.string().min(1),
}).strict();
export type ImportantDocumentRef = z.infer<typeof ImportantDocumentRefSchema>;

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

export const SkillSettingSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  sourceHash: z.string().optional(),
}).strict();
export type SkillSetting = z.infer<typeof SkillSettingSchema>;

export const ControlResearchSchema = z.object({
  githubRepositories: z.array(z.string()),
  githubSearchMode: GitHubSearchModeSchema,
  keywords: z.array(z.string()),
  importantDocuments: z.array(ImportantDocumentRefSchema),
}).strict();
export type ControlResearch = z.infer<typeof ControlResearchSchema>;

export const ControlAgentSchema = z.object({
  systemPrompt: z.object({
    version: z.number().int().positive(),
    content: z.string(),
  }).strict(),
  skills: z.array(SkillSettingSchema),
  mcpServers: z.array(McpServerSettingSchema),
}).strict();
export type ControlAgent = z.infer<typeof ControlAgentSchema>;

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

export const InvestigationControlSchema = InvestigationControlBaseSchema.extend({
  history: z.array(ControlHistoryEntrySchema),
}).strict();
export type InvestigationControl = z.infer<typeof InvestigationControlSchema>;

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
