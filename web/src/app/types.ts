export type AgentRuntime = 'codebuddy-sdk' | 'copilot-sdk' | 'opencode-run';

import type {
  AuditEvent as SharedAuditEvent,
  ConversationTurnSummary as SharedConversationTurnSummary,
  CopilotModelOption as SharedCopilotModelOption,
  CurrentStateSummary as SharedCurrentStateSummary,
  ExecutionStatus as SharedExecutionStatus,
  InvestigationControl as SharedInvestigationControl,
  Message as SharedMessage,
  MissionContract as SharedMissionContract,
  MissionDeliverable as SharedMissionDeliverable,
  MissionDeliverableProgress as SharedMissionDeliverableProgress,
  MissionDraft as SharedMissionDraft,
  MissionProgress as SharedMissionProgress,
  PendingPermission as SharedPendingPermission,
  PendingUserInput as SharedPendingUserInput,
  SessionContextView as SharedSessionContextView,
  SessionDataContract as SharedSessionData,
  SessionSummary as SharedSessionSummary,
  TrajectoryCheckpoint,
  WorkflowId as SharedWorkflowId,
  WorkflowSnapshot as SharedWorkflowSnapshot,
} from '../../../src/api/contracts.js';

export type SessionSummary = SharedSessionSummary;
export type WorkspaceInput = SharedSessionData['context']['inputs'][number];
export type AutoTier = 'efficiency' | 'balance' | 'intelligence' | 'fast';
export type CopilotModelOption = SharedCopilotModelOption;
export type AuditEvent = SharedAuditEvent;
export type PendingPermission = SharedPendingPermission;
export type ExecutionStatus = SharedExecutionStatus;
export type PendingUserInput = SharedPendingUserInput;
export type WorkflowId = SharedWorkflowId;
export type SessionContext = SharedSessionContextView;
export type Message = SharedMessage;
export type SessionData = SharedSessionData;
export type CurrentStateSummary = SharedCurrentStateSummary;
export type InvestigationControl = SharedInvestigationControl;
export type MissionDeliverable = SharedMissionDeliverable;
export type MissionContract = SharedMissionContract;
export type MissionDeliverableProgress = SharedMissionDeliverableProgress;
export type MissionProgress = SharedMissionProgress;
export type MissionDraft = SharedMissionDraft;
export type InvestigationCheckpoint = TrajectoryCheckpoint;
export type JourneyState = SharedWorkflowSnapshot['state'];
export type WorkflowSnapshot = SharedWorkflowSnapshot;
export type ConversationTurnSummary = SharedConversationTurnSummary;
