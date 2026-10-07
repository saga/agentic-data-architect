/**
 * Agent runtime orchestration.
 *
 * The Investigation chooses one preferred runtime. When that runtime exhausts
 * its quota, execution automatically continues with the next configured runtime;
 * no user confirmation is required for this availability fallback.
 */
import path from 'node:path';
import { config } from '../config.js';
import type { AgentRuntime } from '../investigation/schemas.js';
import { askCodeBuddy, resolveCodeBuddyModel } from './codebuddy.js';
import { askCopilot, type AskInput } from './copilot.js';
import { askOpenCode, listOpenCodeModels } from './opencode.js';

function runtimeFromModel(model: string | undefined): AgentRuntime | undefined {
  const value = model?.trim().toLowerCase() ?? '';
  if (value.startsWith('codebuddy:')) return 'codebuddy-sdk';
  if (value.startsWith('opencode:')) return 'opencode-run';
  return undefined;
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|usage\s*limit|rate\s*limit|resource\s*exhausted|credits?\s*(?:exhausted|depleted)|limit\s*(?:reached|exceeded)|HTTP\s*429/i.test(message);
}

function configuredRuntimeOrder(): AgentRuntime[] {
  const result: AgentRuntime[] = [];
  for (const value of config.agentRuntimeFallbackOrder) {
    if (!['codebuddy-sdk', 'copilot-sdk', 'opencode-run'].includes(value)) continue;
    const runtime = value as AgentRuntime;
    if (!result.includes(runtime)) result.push(runtime);
  }
  if (!result.includes(config.agentRuntimeDefault)) result.unshift(config.agentRuntimeDefault);
  return result;
}

function runtimeCandidates(selected: AgentRuntime): AgentRuntime[] {
  const order = configuredRuntimeOrder();
  const index = order.indexOf(selected);
  return index >= 0 ? [selected, ...order.slice(index + 1)] : [selected, ...order];
}

async function resolveOpenCodeModel(requestedModel: string | undefined): Promise<string> {
  const value = requestedModel?.trim() ?? '';
  if (value.toLowerCase().startsWith('opencode:')) return value;
  if (!config.openCodeEnabled) {
    throw new Error('OpenCode 运行时没有启用。');
  }

  const models = await listOpenCodeModels();
  if (!models.length) {
    throw new Error('当前没有可用的 OpenCode 模型。');
  }

  if (config.openCodeFallbackModel) {
    const configured = config.openCodeFallbackModel.trim();
    const normalized = configured.startsWith('opencode:')
      ? configured
      : 'opencode:' + configured;
    const matched = models.find((model) => model.id === normalized);
    if (matched) return matched.id;
  }

  return models[0].id;
}

async function resolveModelForRuntime(
  runtime: AgentRuntime,
  requestedModel: string | undefined,
): Promise<string> {
  const value = requestedModel?.trim() ?? '';
  switch (runtime) {
    case 'codebuddy-sdk':
      return 'codebuddy:' + resolveCodeBuddyModel(
        value.startsWith('codebuddy:') ? value : undefined,
        config.codeBuddyDefaultModel,
      );
    case 'copilot-sdk':
      return value && !value.startsWith('codebuddy:') && !value.startsWith('opencode:') && value.toLowerCase() !== 'auto'
        ? value
        : config.model;
    case 'opencode-run':
      return resolveOpenCodeModel(value);
  }
}

function adaptInput(
  input: AskInput,
  runtime: AgentRuntime,
  model: string,
): AskInput {
  return {
    ...input,
    runtime,
    model,
    // A session belongs to one runtime. A quota fallback starts a fresh session
    // in the next runtime instead of accidentally resuming the previous runtime.
    ...(runtime !== input.runtime ? { sessionId: undefined } : {}),
    ...(runtime !== input.runtime ? {
      onSessionId: (sessionId: string) => input.onSessionId?.(sessionId),
    } : {}),
  };
}

async function executeRuntime(
  runtime: AgentRuntime,
  input: AskInput,
  model: string,
): Promise<string> {
  const adapted = adaptInput(input, runtime, model);
  switch (runtime) {
    case 'codebuddy-sdk':
      return askCodeBuddy(adapted, model);
    case 'copilot-sdk':
      return askCopilot(adapted);
    case 'opencode-run':
      return askOpenCode(adapted);
  }
}

/**
 * Execute the selected runtime and automatically fall back in configured order
 * only when the current runtime reports quota/usage exhaustion.
 */
export async function askAgentWithFallback(input: AskInput): Promise<string> {
  const selectedRuntime = input.runtime ?? runtimeFromModel(input.model) ?? config.agentRuntimeDefault;
  const candidates = runtimeCandidates(selectedRuntime);
  let lastQuotaError: unknown;

  for (let index = 0; index < candidates.length; index += 1) {
    const runtime = candidates[index];
    let model: string;
    try {
      model = await resolveModelForRuntime(runtime, input.model);
    } catch (error) {
      // A disabled/unconfigured fallback is not itself a quota condition. If it is
      // the selected runtime, surface it; otherwise continue to the next runtime
      // because the user asked for automatic availability fallback.
      if (index === 0) throw error;
      lastQuotaError = error;
      continue;
    }

    try {
      return await executeRuntime(runtime, input, model);
    } catch (error) {
      if (!isQuotaError(error) || index === candidates.length - 1) {
        if (lastQuotaError && index === candidates.length - 1 && isQuotaError(error)) {
          throw new Error(
            '所有可用 Agent Runtime 的配额都已达到上限：'
            + candidates.join(' → ')
            + '。最后一个运行时错误：'
            + (error instanceof Error ? error.message : String(error)),
          );
        }
        throw error;
      }

      lastQuotaError = error;
      const nextRuntime = candidates[index + 1];
      let nextModel: string | undefined;
      try {
        nextModel = await resolveModelForRuntime(nextRuntime, input.model);
      } catch {
        // Let the next loop produce the definitive error if no runtime remains.
      }

      input.onStatus?.(
        (runtime === 'codebuddy-sdk' ? 'CodeBuddy' : runtime === 'copilot-sdk' ? 'Copilot' : 'OpenCode')
        + ' 配额已用尽，自动切换到 '
        + (nextRuntime === 'codebuddy-sdk' ? 'CodeBuddy' : nextRuntime === 'copilot-sdk' ? 'Copilot' : 'OpenCode')
        + '，继续当前调查。'
      );
      input.onTrajectory?.({
        type: 'status',
        name: 'Agent Runtime 配额已用尽，自动 fallback',
        status: 'info',
        model: nextModel,
        details: {
          fallback: true,
          fromRuntime: runtime,
          toRuntime: nextRuntime,
          originalError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  throw new Error(
    '没有可用的 Agent Runtime。'
    + (lastQuotaError instanceof Error ? ' 原始错误：' + lastQuotaError.message : ''),
  );
}
