/**
 * Agent runtime selection.
 *
 * Copilot remains the primary runtime. A quota exhaustion is a provider-level
 * availability failure, so the same task can continue on a connected OpenCode
 * model without asking the user to manually restart it.
 */
import path from 'node:path';
import { config } from '../config.js';
import { askCopilot, type AskInput } from './copilot.js';
import { askOpenCode, listOpenCodeModels } from './opencode.js';

function isCopilotQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:monthly\s+quota|quota\s+exceeded|exceeded.*quota|quota)/i.test(message);
}

async function resolveFallbackModel(): Promise<string | undefined> {
  if (!config.openCodeEnabled) return undefined;

  const models = await listOpenCodeModels();
  if (!models.length) return undefined;

  if (config.openCodeFallbackModel) {
    const configured = config.openCodeFallbackModel.trim();
    const normalized = configured.startsWith('opencode:')
      ? configured
      : 'opencode:' + configured;
    const matched = models.find((model) => model.id === normalized);
    if (matched) return matched.id;
  }

  return models[0]?.id;
}

export async function askAgentWithFallback(input: AskInput): Promise<string> {
  if (input.model?.trim().startsWith('opencode:')) {
    return askCopilot(input);
  }

  try {
    return await askCopilot(input);
  } catch (error) {
    if (!isCopilotQuotaError(error)) throw error;

    let fallbackModel: string | undefined;
    try {
      fallbackModel = await resolveFallbackModel();
    } catch {
      fallbackModel = undefined;
    }

    if (!fallbackModel) {
      throw new Error(
        'Copilot 月度配额已用尽，且当前没有可用的 OpenCode 模型。原始错误：'
        + (error instanceof Error ? error.message : String(error)),
      );
    }

    input.onStatus?.('Copilot 月度配额已用尽，已自动切换到 ' + fallbackModel + '，继续当前调查。');
    input.onTrajectory?.({
      type: 'status',
      name: 'Copilot 配额已用尽，自动切换 OpenCode',
      status: 'info',
      model: fallbackModel,
      details: {
        fallback: true,
        fromRuntime: 'copilot',
        toRuntime: 'opencode',
        originalError: error instanceof Error ? error.message : String(error),
      },
    });

    return askOpenCode({
      model: fallbackModel,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      workingDirectory: input.workingDirectory ?? process.cwd(),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.onDelta ? { onDelta: input.onDelta } : {}),
      ...(input.onReasoningDelta ? { onReasoningDelta: input.onReasoningDelta } : {}),
      ...(input.onStatus ? { onStatus: input.onStatus } : {}),
      ...(input.onTrajectory
        ? {
            onTrajectory: (event) => input.onTrajectory?.({
              type: event.type,
              name: event.name,
              ...(event.status !== undefined ? { status: event.status } : {}),
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.details !== undefined ? { details: event.details } : {}),
            }),
          }
        : {}),
      ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
      ...(input.autoContinuationTurns !== undefined ? { autoContinuationTurns: input.autoContinuationTurns } : {}),
      ...(input.missionPrompt !== undefined ? { missionPrompt: input.missionPrompt } : {}),
      ...(input.refreshMissionPrompt ? { refreshMissionPrompt: input.refreshMissionPrompt } : {}),
      ...(input.shouldContinueMission ? { shouldContinueMission: input.shouldContinueMission } : {}),
      ...(input.onStageResult ? { onStageResult: input.onStageResult } : {}),
      ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
      ...(input.onBeforeWorkflowTransition ? { onBeforeWorkflowTransition: input.onBeforeWorkflowTransition } : {}),
      ...(input.workflowSkill !== undefined ? { workflowSkill: input.workflowSkill } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      investigationName: path.basename(input.workingDirectory ?? process.cwd()),
    });
  }
}
