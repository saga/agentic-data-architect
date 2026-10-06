import type {
  ExecutionStatus as SharedExecutionStatus,
  InvestigationControl as SharedInvestigationControl,
  MissionContract as SharedMissionContract,
  MissionDeliverable as SharedMissionDeliverable,
  MissionDeliverableProgress as SharedMissionDeliverableProgress,
  MissionProgress as SharedMissionProgress,
  MissionDraft as SharedMissionDraft,
  TrajectoryCheckpoint,
  WorkflowId as SharedWorkflowId,
  WorkflowSnapshot as SharedWorkflowSnapshot,
} from '../../../src/api/contracts.js';

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

export type ExecutionStatus = SharedExecutionStatus;

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

export type WorkflowId = SharedWorkflowId;

export interface SessionContext {
  name: string;
  mission?: SharedMissionContract;
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

export interface SessionData {
  context: SessionContext;
  missionProgress?: SharedMissionProgress | null;
  control: SharedInvestigationControl;
  recentAudit: AuditEvent[];
  messages: Message[];
  currentState?: CurrentStateSummary | null;
  semanticAssets?: unknown[];
}

export interface CurrentStateSummary {
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
}

export type InvestigationControl = SharedInvestigationControl;
export type MissionDeliverable = SharedMissionDeliverable;
export type MissionContract = SharedMissionContract;
export type MissionDeliverableProgress = SharedMissionDeliverableProgress;
export type MissionProgress = SharedMissionProgress;
export type MissionDraft = SharedMissionDraft;
export type InvestigationCheckpoint = TrajectoryCheckpoint;
export type JourneyState = SharedWorkflowSnapshot['state'];
export type WorkflowSnapshot = SharedWorkflowSnapshot;
