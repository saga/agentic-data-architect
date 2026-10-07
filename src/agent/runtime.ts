/**
 * Agent runtime orchestration.
 *
 * The Investigation chooses one preferred runtime. When that runtime exhausts
 * its quota, execution automatically continues with the next configured runtime;
 * no user confirmation is required for this availability fallback.
 */
import { config } from '../config.js';
import type { AgentRuntime } from '../investigation/schemas.js';
import { askCodeBuddy, normalizeCodeBuddyModel, resolveCodeBuddyModel } from './codebuddy.js';
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

function resolveCodeBuddyModels(requestedModel?: string): string[] {
  const requested = normalizeCodeBuddyModel(requestedModel);
  const base = [config.codeBuddyDefaultModel, ...config.codeBuddyModelAllowlist]
    .map((model) => model.trim())
    .filter(Boolean);

  const ordered = [...new Map(
    base.map((model) => [model.toLowerCase(), model]),
  ).values()];

  if (!requested || requested.toLowerCase() === 'auto') return ordered;

  const requestedIndex = ordered.findIndex(
    (model) => model.toLowerCase() === requested.toLowerCase(),
  );
  if (requestedIndex >= 0) return ordered.slice(requestedIndex);

  return [requested, ...ordered];
}

async function resolveModelForRuntime(
  runtime: AgentRuntime,
  requestedModel: string | undefined,
): Promise<string> {
  const value = requestedModel?.trim() ?? '';
  switch (runtime) {
    case 'codebuddy-sdk':
      return resolveCodeBuddyModels(value.startsWith('codebuddy:') ? value : undefined)[0]
        ?? resolveCodeBuddyModel(undefined, config.codeBuddyDefaultModel);
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
): AskInput & { model: string } {
  const inputModel = runtime === 'codebuddy-sdk'
    ? normalizeCodeBuddyModel(input.model)
    : input.model;
  const preserveSession =
    runtime === input.runtime
    && model === inputModel
    && Boolean(input.sessionId);

  const { sessionId, onSessionId, ...rest } = input;
  return {
    ...rest,
    runtime,
    model,
    // A session belongs to one runtime+model selection. A quota fallback starts
    // a fresh session and never persists that fallback session as the preferred runtime.
    ...(preserveSession && sessionId
      ? { sessionId, ...(onSessionId ? { onSessionId } : {}) }
      : {}),
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
      return askOpenCode({ ...adapted, model });
  }
}

/**
 * Execute the selected runtime and automatically fall back in configured order
 * only when the current runtime reports quota/usage exhaustion.
 */
export async function askAgentWithFallback(input: AskInput): Promise<string> {
  const selectedRuntime = input.runtime ?? runtimeFromModel(input.model) ?? config.agentRuntimeDefault;
  const runtimeOrder = runtimeCandidates(selectedRuntime);
  const attempts: Array<{ runtime: AgentRuntime; model?: string }> = [];

  for (const runtime of runtimeOrder) {
    if (runtime === 'codebuddy-sdk') {
      attempts.push(
        ...resolveCodeBuddyModels(
          runtime === selectedRuntime ? input.model : undefined,
        ).map((model) => ({
          runtime,
          model,
        })),
      );
      continue;
    }

    let model: string;
    try {
      model = await resolveModelForRuntime(runtime, input.model);
    } catch (error) {
      // Resolution failure for the selected runtime must surface; a fallback runtime
      // may be unavailable and can simply be skipped.
      if (runtime === selectedRuntime) throw error;
      continue;
    }
    attempts.push({ runtime, model });
  }

  let lastQuotaError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const model = attempt.model;
    if (!model) continue;

    try {
      return await executeRuntime(attempt.runtime, input, model);
    } catch (error) {
      if (!isQuotaError(error) || index === attempts.length - 1) {
        throw error;
      }

      lastQuotaError = error;
      const next = attempts[index + 1];
      const sameRuntime = next.runtime === attempt.runtime;
      const runtimeLabel = (value: AgentRuntime) =>
        value === 'codebuddy-sdk' ? 'CodeBuddy' : value === 'copilot-sdk' ? 'Copilot' : 'OpenCode';

      input.onStatus?.(
        sameRuntime
          ? 'CodeBuddy 当前模型配额已用尽，自动切换到下一个 CodeBuddy 模型，继续当前调查。'
          : runtimeLabel(attempt.runtime) + ' 配额已用尽，自动切换到 ' + runtimeLabel(next.runtime) + '，继续当前调查。',
      );
      input.onTrajectory?.({
        type: 'status',
        name: sameRuntime
          ? 'CodeBuddy 模型配额已用尽，自动 fallback'
          : 'Agent Runtime 配额已用尽，自动 fallback',
        status: 'info',
        ...(next.model !== undefined ? { model: next.model } : {}),
        details: {
          fallback: true,
          fromRuntime: attempt.runtime,
          toRuntime: next.runtime,
          ...(sameRuntime ? { fromModel: model, toModel: next.model } : {}),
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
