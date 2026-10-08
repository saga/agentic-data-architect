import type { ZodType } from 'zod';
import type { WorkflowId } from '../investigation/schemas.js';

export interface AgentTrajectoryEvent {
  type:
    | 'user_input'
    | 'turn_start'
    | 'assistant_turn_start'
    | 'assistant_turn_end'
    | 'intent'
    | 'model_call'
    | 'tool_call'
    | 'tool_result'
    | 'tool_progress'
    | 'permission'
    | 'permission_completed'
    | 'user_input_requested'
    | 'user_input_completed'
    | 'compaction'
    | 'session_idle'
    | 'session_error'
    | 'context_changed'
    | 'turn_end'
    | 'error'
    | 'checkpoint'
    | 'stage_gate'
    | 'status';
  name: string;
  status?: 'started' | 'completed' | 'failed' | 'waiting' | 'info';
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  premiumRequestCost?: number;
  details?: Record<string, unknown>;
}

export interface AskInput {
  prompt: string;
  systemPrompt: string;
  onTrajectory?: (event: AgentTrajectoryEvent) => void;
  sessionId?: string;
  workingDirectory?: string;
  investigationName?: string;
  runtime?: import('../investigation/schemas.js').AgentRuntime;
  model?: string;
  modelCallName?: string;
  /** Copilot 模型档位；默认 standard，只有明确简单的高频调用才使用 simple。 */
  modelTier?: 'standard' | 'simple';
  autoTier?: 'efficiency' | 'balance' | 'intelligence' | 'fast';
  missionPrompt?: string;
  refreshMissionPrompt?: () => string | Promise<string>;
  shouldContinueMission?: () => boolean | Promise<boolean>;
  missionActionGate?: (input: {
    execution: number;
    toolName: string;
    toolArgs: unknown;
  }) => Promise<{ allowed: boolean; reason: string; targetDeliverableId?: string | null }>;
  onReasoningDelta?: (delta: string) => void;
  onStageResult?: (result: { content: string; execution: number }) =>
    void | Promise<void | { passed?: boolean; error?: string }>;
  onBeforeWorkflowTransition?: (result: { content: string; execution: number }) => Promise<void>;
  workflowSkill?: WorkflowId;
  purpose?: 'investigation' | 'journey-map' | 'review';
  skillDirectories?: string[];
  platformCapabilities?: ReadonlyArray<{ name: string; version: number; enabled: boolean }>;
  permissionMode?: 'permission' | 'allow_all';
  mcpServers?: Record<string, unknown>;
  onDelta?: (delta: string) => void;
  onStatus?: (status: string) => void;
  onSessionId?: (sessionId: string) => void;
  turnId?: string;
  shouldAbort?: () => boolean;
  autoContinuationTurns?: number;
  responseSchema?: ZodType;
}
