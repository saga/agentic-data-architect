import type { WorkflowId as ApiWorkflowId } from '../../../src/api/contracts';
/** 首页与调查页共用的数据结构。把类型从 App.tsx 移出来，页面文件只负责 UI 与交互。 */
export interface SessionSummary {
  key: string;
  label: string;
  userPrompt: string;
  updatedAt: string;
}

export interface WorkspaceInput {
  id: string;
  kind: string;
  title: string;
  artifactPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
}

export type AutoTier = 'efficiency' | 'balance' | 'intelligence' | 'fast';

export interface CopilotModelOption {
  id: string;
  name: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  policyState: string | null;
  runtime?: 'copilot' | 'opencode';
}

export interface InvestigationControl {
  schemaVersion: number;
  version: number;
  updatedAt: string;
  research: {
    githubRepositories: string[];
    githubSearchMode: 'only_selected' | 'selected_and_broad';
    keywords: string[];
    importantDocuments: Array<{ id: string; title: string; reference: string }>;
  };
  agent: {
    model: string;
    autoTier?: AutoTier;
    permissionMode: 'permission' | 'allow_all';
    displayName: string;
    personality: string;
    avatarPath?: string;
    avatarPaths?: string[];
    avatarMimeType?: string;
    avatarSources?: Array<{ src: string; kind: 'image' | 'video' | 'remote'; mimeType?: string }>;
    autoContinuationTurns: number;
    avatarWidth: number;
    avatarHeight: number;
    systemPrompt: {
      version: number;
      content: string;
    };
    platformCapabilities: Array<{ name: string; version: number; enabled: boolean }>;
    mcpServers: Array<{
      name: string;
      version: number;
      enabled: boolean;
      type: 'local' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      tools?: string[];
      headers?: Record<string, string>;
    }>;
  };
  history: Array<{
    version: number;
    updatedAt: string;
    reason: string;
  }>;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: 'user' | 'system';
  action: string;
  summary: string;
  configurationVersion?: number;
  details?: Record<string, unknown>;
}

export interface PendingPermission {
  sessionName: string;
  turnId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  requestedAt: string;
  intention?: string;
  fullCommandText?: string;
  fileName?: string;
  path?: string;
  serverName?: string;
  toolName?: string;
  toolTitle?: string;
  readOnly?: boolean;
  managedApprovalRequired?: boolean;
}

export interface ExecutionStatus {
  state: 'idle' | 'running' | 'waiting_permission' | 'waiting_user_input' | 'committing';
  running: boolean;
  turnId: string | null;
  phase: 'executing' | 'committing' | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  lastActivity: string | null;
  pendingPermissionCount: number;
  pendingUserInputCount: number;
}

export interface PendingUserInput {
  sessionName: string;
  turnId: string;
  sessionId: string;
  requestId: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  requestedAt: string;
}

export interface MissionDeliverable {
  id: string;
  title: string;
  description: string;
  required: boolean;
}

export interface MissionContract {
  version: 1;
  purpose: string;
  expectedResult: string;
  deliverables: MissionDeliverable[];
  status: 'confirmed';
  confirmedAt: string;
  confirmedBy: 'user';
}

export interface MissionDraft {
  purpose: string;
  expectedResult: string;
  deliverableIds: string[];
}

export type MissionDeliverableStatus =
  | 'covered'
  | 'in_progress'
  | 'not_started'
  | 'not_tracked';

export interface MissionDeliverableProgress {
  id: string;
  title: string;
  description: string;
  required: boolean;
  status: MissionDeliverableStatus;
  detail: string;
}

export interface MissionProgress {
  covered: number;
  total: number;
  percent: number;
  deliverables: MissionDeliverableProgress[];
}

export type WorkflowId = ApiWorkflowId;

export const workflowOptions = [
  { value: '', label: '自主调查' },
  { value: 'legacy-modernization', label: '改造已有系统' },
  { value: 'financial-ai-native-architecture', label: '金融 AI / 数据架构设计' },
  { value: 'data-architecture-assessment', label: '数据架构评估' },
] as const;

export interface SessionContext {
  name: string;
  mission?: MissionContract;
  workflow: WorkflowId | null;
  userPrompt: string;
  goal: string;
  scope: string[];
  systems: string[];
  evidence: unknown[];
  findings: Array<{ severity?: string; status?: string; title?: string }>;
  unknowns: string[];
  claims: unknown[];
  inputs: WorkspaceInput[];
  /** 最近一次 Agent 根据用户动作与证据重新规划的可选路线。 */
  journeyPlan?: {
    version: number;
    source: 'agent';
    generatedAt: string;
    turnId?: string;
    routes: Array<{
      id: string;
      title: string;
      reason: string;
      steps: string[];
    }>;
  };
  updatedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  capturedAt: string;
}

export interface InvestigationCheckpoint {
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

export interface SessionData {
  context: SessionContext;
  /** 根据 Mission 交付物和已落盘状态计算的当前覆盖情况。 */
  missionProgress?: MissionProgress | null;
  control: InvestigationControl;
  recentAudit: AuditEvent[];
  messages: Message[];
  currentState?: {
    coverage: {
      datasets: number;
      connectedDatasets: number;
      datasetLineageConnectionRate: number | null;
      sqlParseFailures: number;
      semanticAssets: number;
      profiledDatasets: number;
    };
    sourceOfTruthCandidates: unknown[];
    semanticCandidates: unknown[];
    highValueAssets: string[];
  } | null;
  semanticAssets?: unknown[];
}

export interface JourneyState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: Array<{
    id: string;
    title: string;
    objective: string;
    status: 'completed' | 'current' | 'locked' | 'future';
    nodeType: 'task' | 'gate' | 'review' | 'end' | 'stop';
    unlocked: boolean;
  }>;
}
