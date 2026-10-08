/**
 * Agent Runtime 统一入口。
 *
 * 这里解决的不是具体 Agent SDK 的调用细节，而是“这次调用应该由哪个 Runtime /
 * Model 执行、什么时候允许 fallback、Session 是否可以复用、失败怎样记录”这些
 * 跨 Runtime 的共同问题。
 *
 * 关键规则：
 * 1. Investigation 只保存用户选择的首选 Runtime；quota / usage exhaustion 只是运行时可用性问题，
 *    不应该反过来修改用户的任务配置。
 * 2. 同一个 Runtime + Model + Session 可以继续使用原 Session；切换 Runtime 或 Model
 *    必须从新的 Session 开始，避免两个 SDK 的上下文状态互相污染。
 * 3. 只有明确属于 quota / rate limit / resource exhausted 的失败才允许自动 fallback；
 *    普通代码错误、权限错误、参数错误不能被吞掉后“换个模型碰碰运气”。
 * 4. 每次 Runtime 尝试都要进入 trajectory / audit，并记录开始、结束、失败和耗时，
 *    否则长时间运行时用户无法判断到底卡在模型、工具还是 fallback。
 */
import { config } from '../config.js';
import type { AgentRuntime } from '../investigation/schemas.js';
import { askCodeBuddy, normalizeCodeBuddyModel, resolveCodeBuddyModel } from './codebuddy.js';
import { askCopilot } from './copilot.js';
import type { AskInput } from './ask-input.js';
import { askOpenCode, listOpenCodeModels } from './opencode.js';
import { syncRuntimeSkillWorkspace } from '../skills/catalog.js';
import { appendAuditEvent } from '../investigation/control.js';

function runtimeFromModel(model: string | undefined): AgentRuntime | undefined {
  const value = model?.trim().toLowerCase() ?? '';
  if (value.startsWith('codebuddy:')) return 'codebuddy-sdk';
  if (value.startsWith('opencode:')) return 'opencode-run';
  return undefined;
}

function runtimeLabel(value: AgentRuntime): string {
  return value === 'codebuddy-sdk' ? 'CodeBuddy' : value === 'copilot-sdk' ? 'Copilot' : 'OpenCode';
}

function resolvedModelCallName(input: AskInput): string {
  if (input.modelCallName?.trim()) return input.modelCallName.trim();
  if (input.responseSchema) return '结构化判断';
  if (input.purpose === 'review') return '辅助判断';
  if (input.purpose === 'journey-map') return '生成工作地图';
  return '主调查';
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:quota|rate[-\s]?limit|resource\s+exhausted|credits?\s+(?:exhausted|depleted))\b/i.test(message)
    || /\bHTTP\s*429\b/i.test(message)
    || /\b(?:429|402)\s*[:\-]?\s*(?:quota|credits?|rate|usage)/i.test(message);
}

/** 读取应用级 fallback 顺序并去重；非法配置项直接忽略，默认 Runtime 始终排第一。 */
/**
 * 同一 Investigation turn 内，一个 Runtime 一旦明确返回 quota / rate-limit，
 * 后续的 Smart Function / review 调用不应再次从头尝试这个 Runtime。
 *
 * 典型场景是：
 *   主调查 → Mission Alignment → Unknown Review → Completion Review
 * 每一步都是独立的模型调用，但它们共享同一个 turnId。第一次 Copilot 某模型明确
 * 返回月度配额耗尽后，如果没有这个状态，每个 review 都会再次浪费约 5 秒尝试同一个模型，
 * 然后才 fallback。这里只屏蔽“失败的 Runtime + Model”，不会把整个 Runtime 永久禁掉，
 * 因为同一个 Runtime 仍可能有另一个可用模型。
 *
 * 这里只记“本轮暂不可用”，不会修改用户保存的 Runtime 配置；turn 结束时由 ask.ts 清理。
 */
const quotaBlockedModelsByTurn = new Map<string, Set<string>>();

export function clearRuntimeFallbackState(turnId: string | undefined): void {
  if (turnId) quotaBlockedModelsByTurn.delete(turnId);
}

function modelKey(runtime: AgentRuntime, model: string): string {
  return runtime + '\0' + model;
}

function blockedModelsForTurn(turnId: string | undefined): Set<string> {
  if (!turnId) return new Set();
  return quotaBlockedModelsByTurn.get(turnId) ?? new Set();
}

function blockModelForTurn(turnId: string | undefined, runtime: AgentRuntime, model: string): void {
  if (!turnId) return;
  const blocked = quotaBlockedModelsByTurn.get(turnId) ?? new Set<string>();
  blocked.add(modelKey(runtime, model));
  quotaBlockedModelsByTurn.set(turnId, blocked);
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

/** 从用户选定 Runtime 开始向后寻找可用候选，不会跨过用户指定 Runtime 反向尝试。 */
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
  modelTier: AskInput['modelTier'],
): Promise<string> {
  const value = requestedModel?.trim() ?? '';
  switch (runtime) {
    case 'codebuddy-sdk':
      return resolveCodeBuddyModels(value.startsWith('codebuddy:') ? value : undefined)[0]
        ?? resolveCodeBuddyModel(undefined, config.codeBuddyDefaultModel);
    case 'copilot-sdk':
      return value && !value.startsWith('codebuddy:') && !value.startsWith('opencode:') && value.toLowerCase() !== 'auto'
        ? value
        : modelTier === 'simple'
          ? config.simpleModel
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
    // 一个 Agent Session 只属于固定的 Runtime + Model 组合。发生 quota fallback 时必须新建 Session，
    // 不能把备用 Runtime 的 Session 写回 Investigation，覆盖用户原来选择的首选 Runtime。
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
  if (
    runtime !== 'copilot-sdk'
    && adapted.workingDirectory
    && adapted.purpose !== 'review'
  ) {
    await syncRuntimeSkillWorkspace(
      adapted.workingDirectory,
      adapted.purpose === 'journey-map' ? undefined : adapted.workflowSkill,
    );
  }
  switch (runtime) {
    case 'codebuddy-sdk':
      return askCodeBuddy(adapted, model);
    case 'copilot-sdk':
      return askCopilot(adapted);
    case 'opencode-run': {
      const workingDirectory = adapted.workingDirectory;
      if (!workingDirectory) {
        throw new Error('OpenCode 运行时需要 workingDirectory。');
      }
      return askOpenCode({ ...adapted, model, workingDirectory });
    }
  }
}

/**
 * 执行选定的 Runtime；只有当前 Runtime 明确报告 quota / rate-limit / resource exhaustion
 * 时才自动 fallback。
 *
 * 注意：一次 Investigation turn 可能包含多次独立的 Smart Function 调用。turnId 用于
 * 共享本轮 Runtime 健康状态，防止已经确认 quota 耗尽的 Runtime 被后续 review 再次尝试。
 */
export async function askAgentWithFallback(input: AskInput): Promise<string> {
  const selectedRuntime = input.runtime ?? runtimeFromModel(input.model) ?? config.agentRuntimeDefault;
  const blockedModels = blockedModelsForTurn(input.turnId);
  const runtimeOrder = runtimeCandidates(selectedRuntime);
  const allAttempts: Array<{ runtime: AgentRuntime; model?: string }> = [];


  for (const runtime of runtimeOrder) {
    if (runtime === 'codebuddy-sdk') {
      allAttempts.push(
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
      model = await resolveModelForRuntime(runtime, input.model, input.modelTier);
    } catch (error) {
      // Resolution failure for the selected runtime must surface; a fallback runtime
      // may be unavailable and can simply be skipped. Either way it is operationally
      // important: otherwise the reason a fallback was skipped disappears from logs.
      console.warn('[agent-runtime] Failed to resolve runtime model.', {
        investigationName: input.investigationName,
        runtime,
        selectedRuntime,
        error,
      });
      if (input.investigationName) {
        await appendAuditEvent(input.investigationName, {
          actor: 'system',
          action: 'agent.runtime.model_resolution_failed',
          summary: 'Agent Runtime 模型解析失败。',
          details: {
            runtime,
            selectedRuntime,
            error: error instanceof Error ? error.message : String(error),
          },
        }).catch((auditError) => {
          console.error('[agent-runtime] Failed to persist model resolution failure audit.', {
            investigationName: input.investigationName,
            runtime,
            error: auditError,
          });
        });
      }
      if (runtime === selectedRuntime) throw error;
      continue;
    }
    allAttempts.push({ runtime, model });
  }

  const attempts = allAttempts.filter((attempt) =>
    attempt.model ? !blockedModels.has(modelKey(attempt.runtime, attempt.model)) : true,
  );
  if (attempts.length !== allAttempts.length) {
    const skipped = allAttempts.filter((attempt) =>
      attempt.model && blockedModels.has(modelKey(attempt.runtime, attempt.model)),
    );
    console.info('[agent-runtime] Skipping model(s) already known to be quota-limited in this turn.', {
      investigationName: input.investigationName,
      turnId: input.turnId,
      selectedRuntime,
      skipped: skipped.map((item) => ({ runtime: item.runtime, model: item.model })),
    });
    input.onTrajectory?.({
      type: 'status',
      name: '已跳过本轮已知配额不足的模型',
      status: 'info',
      details: {
        skipped: skipped.map((item) => ({ runtime: item.runtime, model: item.model })),
      },
    });
  }

  let lastQuotaError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const model = attempt.model;
    if (!model) continue;

    const callName = resolvedModelCallName(input);
    const runtimeName = runtimeLabel(attempt.runtime);
    const callStartedAt = Date.now();
    input.onTrajectory?.({
      type: 'status',
      name: callName + '正在调用模型',
      status: 'started',
      model,
      details: { runtime: attempt.runtime, purpose: input.purpose ?? 'investigation', ...(input.responseSchema ? { structuredOutput: true } : {}) },
    });

    console.info('[agent-runtime] Starting model execution.', {
      investigationName: input.investigationName,
      runtime: attempt.runtime,
      model,
      purpose: input.purpose ?? 'investigation',
      attempt: index + 1,
      totalAttempts: attempts.length,
    });

    if (input.investigationName) {
      await appendAuditEvent(input.investigationName, {
        actor: 'system',
        action: 'agent.runtime.started',
        summary: 'Agent Runtime 开始执行模型调用。',
        details: {
          runtime: attempt.runtime,
          model,
          purpose: input.purpose ?? 'investigation',
          attempt: index + 1,
          totalAttempts: attempts.length,
        },
      }).catch((auditError) => {
        console.error('[agent-runtime] Failed to persist runtime start audit.', {
          investigationName: input.investigationName,
          runtime: attempt.runtime,
          error: auditError,
        });
      });
    }

    try {
      const result = await executeRuntime(attempt.runtime, input, model);
      if (attempt.runtime !== 'copilot-sdk') {
        input.onTrajectory?.({
          type: 'model_call',
          name: callName + '（' + runtimeName + '）',
          status: 'completed',
          durationMs: Math.max(0, Date.now() - callStartedAt),
          model,
          details: {},
        });
      }
      console.info('[agent-runtime] Model execution completed.', {
        investigationName: input.investigationName,
        runtime: attempt.runtime,
        model,
        durationMs: Math.max(0, Date.now() - callStartedAt),
      });
      return result;
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - callStartedAt);
      console.error('[agent-runtime] Model execution failed.', {
        investigationName: input.investigationName,
        runtime: attempt.runtime,
        model,
        durationMs,
        quotaError: isQuotaError(error),
        error,
      });
      if (input.investigationName) {
        await appendAuditEvent(input.investigationName, {
          actor: 'system',
          action: 'agent.runtime.failed',
          summary: 'Agent Runtime 模型调用失败。',
          details: {
            runtime: attempt.runtime,
            model,
            durationMs,
            quotaError: isQuotaError(error),
            error: error instanceof Error ? error.message : String(error),
          },
        }).catch((auditError) => {
          console.error('[agent-runtime] Failed to persist runtime failure audit.', {
            investigationName: input.investigationName,
            runtime: attempt.runtime,
            error: auditError,
          });
        });
      }
      if (attempt.runtime !== 'copilot-sdk') {
        input.onTrajectory?.({
          type: 'model_call',
          name: callName + '（' + runtimeName + '）',
          status: 'failed',
          durationMs: Math.max(0, Date.now() - callStartedAt),
          model,
          details: {},
        });
      }
      if (!isQuotaError(error) || index === attempts.length - 1) {
        throw error;
      }

      lastQuotaError = error;
      blockModelForTurn(input.turnId, attempt.runtime, model);
      const next = attempts[index + 1];
      const sameRuntime = next.runtime === attempt.runtime;
      const runtimeLabel = (value: AgentRuntime) =>
        value === 'codebuddy-sdk' ? 'CodeBuddy' : value === 'copilot-sdk' ? 'Copilot' : 'OpenCode';

      console.warn('[agent-runtime] Falling back after quota/usage exhaustion.', {
        investigationName: input.investigationName,
        fromRuntime: attempt.runtime,
        fromModel: model,
        toRuntime: next.runtime,
        toModel: next.model,
      });

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
    attempts.length === 0 && blockedModels.size > 0
      ? '本轮可用的模型都已经因配额/限流失败而被跳过，请稍后重试或更换运行方式。'
      : '没有可用的 Agent Runtime。'
        + (lastQuotaError instanceof Error ? ' 原始错误：' + lastQuotaError.message : ''),
  );
}
