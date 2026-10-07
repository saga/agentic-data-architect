/**
 * CodeBuddy Agent SDK runtime adapter.
 *
 * CodeBuddy SDK runs in an isolated SDK environment by default. This adapter
 * explicitly supplies the Investigation working directory, MCP capability,
 * permission policy and prompt so the surrounding application remains the
 * owner of Mission / Evidence / Workflow state.
 */
import { createSdkMcpServer, query, tool as codeBuddyTool, AbortError } from '@tencent-ai/agent-sdk';
import path from 'node:path';
import {
  GRAPHIFY_MCP_NAME,
  GRAPHIFY_SELECTION_INSTRUCTION,
  buildGraphifyMcpServer,
  ensureGraphifyGraph,
  isGraphifyTool,
} from '../adapters/graphify.js';
import type { AgentRuntime } from '../investigation/schemas.js';
import type { McpServerSetting } from '../investigation/schemas.js';
import { applyAgentWorkflowTransition, buildJourneyAgentInstruction } from '../workflow/journey-editor.js';
import { requiresGraphifyFirst as requiresGraphifyPrompt } from './opencode.js';
import { createLocalDataTools } from './local-data-tools.js';
import { requestAgentUserInput, type AskInput } from './copilot.js';

const activeCodeBuddyTurns = new Map<string, () => Promise<void>>();

export interface CodeBuddyModelOption {
  id: string;
  name: string;
  runtime: 'codebuddy';
}

export function isCodeBuddyModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('codebuddy:');
}

export function normalizeCodeBuddyModel(model: string | undefined): string {
  const value = model?.trim() ?? '';
  if (value.toLowerCase().startsWith('codebuddy:')) return value.slice('codebuddy:'.length);
  return value;
}

/** 配置中的 CodeBuddy 模型顺序同时承担下拉过滤顺序和默认候选顺序。 */
export function listCodeBuddyModels(
  allowlist: readonly string[],
): CodeBuddyModelOption[] {
  return [...new Set(allowlist.map((item) => item.trim()).filter(Boolean))]
    .map((id) => ({
      id: 'codebuddy:' + id,
      name: 'CodeBuddy · ' + id,
      runtime: 'codebuddy' as const,
    }));
}

export function resolveCodeBuddyModel(
  requestedModel: string | undefined,
  configuredDefaultModel: string,
): string {
  const normalized = normalizeCodeBuddyModel(requestedModel);
  if (normalized && normalized.toLowerCase() !== 'auto') return normalized;
  return configuredDefaultModel.trim();
}

function toCodeBuddyMcpServers(
  settings: readonly McpServerSetting[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const server of settings) {
    if (!server.enabled) continue;
    if (server.type === 'local') {
      if (!server.command) continue;
      result[server.name] = {
        type: 'stdio',
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
      };
      continue;
    }
    if (server.url) {
      result[server.name] = {
        type: 'http',
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }
  return result;
}


interface WorkbenchToolLike {
  name: string;
  description: string;
  parameters: unknown;
  handler: (input: unknown) => Promise<unknown> | unknown;
}

/**
 * 把现有 Workbench tools 适配为 CodeBuddy SDK 的 in-process MCP server。
 *
 * 业务 tool implementation 仍只有一份；CodeBuddy 只是换了 Runtime adapter。
 */
function buildCodeBuddyWorkbenchServer(sessionName: string): ReturnType<typeof createSdkMcpServer> {
  const tools = createLocalDataTools(sessionName) as unknown as WorkbenchToolLike[];
  const serverTools = tools.map((item) =>
    (codeBuddyTool as unknown as (definition: {
      name: string;
      description: string;
      schema: unknown;
      handler: (input: unknown) => Promise<unknown> | unknown;
    }) => unknown)({
      name: item.name,
      description: item.description,
      schema: item.parameters,
      handler: item.handler,
    }),
  );

  return createSdkMcpServer({
    name: 'workbench',
    tools: serverTools as never[],
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof AbortError) return 'Turn aborted.';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return String(error);
}

/** 停止当前 CodeBuddy turn；由通用 Stop API 复用。 */
export async function abortCodeBuddyTurn(turnId: string): Promise<boolean> {
  const abort = activeCodeBuddyTurns.get(turnId);
  if (!abort) return false;
  try {
    await abort();
    return true;
  } catch {
    return false;
  }
}

interface CodeBuddyQueryResult {
  answer: string;
  sessionId: string;
  toolCount: number;
  graphifyUsed: boolean;
  modelError?: string;
  usage?: Record<string, unknown>;
}

async function runCodeBuddyQuery(
  input: AskInput,
  model: string,
  prompt: string,
  workflowInstruction: string,
  mcpServers: Record<string, unknown>,
  execution: number,
  graphifyEnabled: boolean,
  graphifyPreflight: boolean,
  graphifyRequired: boolean,
): Promise<CodeBuddyQueryResult> {
  const graphifyUsedRef = { value: false };

  const queryOptions = {
    model,
    cwd: input.workingDirectory ?? process.cwd(),
    permissionMode: (input.permissionMode ?? 'allow_all') === 'allow_all'
      ? 'bypassPermissions' as const
      : 'default' as const,
    // SDK defaults to no filesystem settings; Workbench explicitly supplies all
    // tools/configuration it wants, so user/project .codebuddy files cannot alter it.
    settingSources: [],
    systemPrompt: [
      input.missionPrompt,
      input.systemPrompt,
      graphifyEnabled ? GRAPHIFY_SELECTION_INSTRUCTION : '',
      workflowInstruction,
    ].filter(Boolean).join('\n\n'),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    maxTurns: 20,
    canUseTool: async (
      toolName: string,
      toolInput: unknown,
    ) => {
      const graphifyToolCall = isGraphifyTool({ toolName });
      if (graphifyToolCall) graphifyUsedRef.value = true;

      if (toolName === 'AskUserQuestion') {
        const questions = toolInput && typeof toolInput === 'object'
          && Array.isArray((toolInput as Record<string, unknown>).questions)
          ? (toolInput as Record<string, unknown>).questions as Array<Record<string, unknown>>
          : [];
        const answers: Record<string, string> = {};
        for (const question of questions) {
          const textValue = typeof question.question === 'string' ? question.question : '请提供必要信息。';
          const choices = Array.isArray(question.options)
            ? question.options
              .map((option) => option && typeof option === 'object' && typeof (option as Record<string, unknown>).label === 'string'
                ? (option as Record<string, unknown>).label as string
                : '')
              .filter(Boolean)
            : [];
          const response = await requestAgentUserInput(
            input.investigationName ?? path.basename(input.workingDirectory ?? process.cwd()),
            input.turnId ?? '',
            input.sessionId ?? '',
            {
              question: textValue,
              choices,
              allowFreeform: true,
            },
            input.onStatus,
            input.onTrajectory,
          );
          answers[textValue] = response.answer;
        }
        return {
          behavior: 'allow' as const,
          updatedInput: {
            ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
            answers,
          },
        };
      }

      if (graphifyPreflight && !graphifyToolCall) {
        return {
          behavior: 'deny' as const,
          message: '结构调查前置阶段必须先使用 Graphify；当前步骤暂不允许使用其它工具。',
          interrupt: false,
        };
      }

      if (input.missionActionGate && !['AskUserQuestion', 'Skill'].includes(toolName)) {
        const review = await input.missionActionGate({
          execution,
          toolName,
          toolArgs: toolInput,
        });
        if (!review.allowed) {
          return {
            behavior: 'deny' as const,
            message: review.reason,
          };
        }
      }

      return {
        behavior: 'allow' as const,
        updatedInput: toolInput,
      };
    },
  };

  const q = query({
    prompt,
    options: queryOptions as NonNullable<Parameters<typeof query>[0]['options']>,
  });

  let sessionId = '';
  let answer = '';
  let modelError: string | undefined;
  let toolCount = 0;
  let usage: Record<string, unknown> | undefined;

  const abort = async () => {
    await q.interrupt();
  };
  if (input.turnId) activeCodeBuddyTurns.set(input.turnId, abort);

  try {
    input.onTrajectory?.({
      type: 'turn_start',
      name: 'CodeBuddy SDK Agent 开始',
      status: 'started',
      model,
      details: {
        runtime: 'codebuddy-sdk',
        execution,
        workingDirectory: input.workingDirectory ?? process.cwd(),
      },
    });

    for await (const message of q) {
      const raw = message as unknown as Record<string, unknown>;

      if (raw.type === 'system' && typeof raw.session_id === 'string') {
        sessionId = raw.session_id;
        input.sessionId = sessionId;
        input.onSessionId?.(sessionId);
        continue;
      }

      if (raw.type === 'assistant') {
        const assistantMessage = raw.message;
        if (!assistantMessage || typeof assistantMessage !== 'object') continue;
        const blocks = (assistantMessage as Record<string, unknown>).content;
        if (!Array.isArray(blocks)) continue;

        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          const part = block as Record<string, unknown>;

          if (part.type === 'text' && typeof part.text === 'string') {
            const text = part.text;
            if (text.trim()) {
              answer += (answer ? '\n' : '') + text;
              input.onDelta?.(text);
            }
          } else if (part.type === 'tool_use') {
            toolCount += 1;
            const toolName = typeof part.name === 'string' ? part.name : '工具';
            const graphifyToolCall = isGraphifyTool({ toolName });
            if (graphifyToolCall) graphifyUsedRef.value = true;

            input.onStatus?.(
              graphifyToolCall
                ? 'Graphify 正在帮助助手梳理代码结构，请稍候…'
                : 'CodeBuddy 正在使用工具 ' + toolName + '，请稍候…',
            );
            input.onTrajectory?.({
              type: 'tool_call',
              name: graphifyToolCall ? 'Graphify 结构分析：' + toolName : 'CodeBuddy 工具：' + toolName,
              status: 'started',
              model,
              details: {
                execution,
                ...(sessionId ? { sessionId } : {}),
                tool: toolName,
                ...(graphifyToolCall ? {
                  mcpServerName: GRAPHIFY_MCP_NAME,
                  mcpToolName: toolName,
                } : {}),
              },
            });
          } else if (part.type === 'tool_result') {
            const toolName = typeof part.name === 'string' ? part.name : '工具';
            input.onTrajectory?.({
              type: 'tool_result',
              name: 'CodeBuddy 工具结果：' + toolName,
              status: 'completed',
              model,
              details: {
                execution,
                ...(sessionId ? { sessionId } : {}),
                tool: toolName,
              },
            });
          } else if (
            (part.type === 'thinking' || part.type === 'reasoning')
            && typeof part.thinking === 'string'
          ) {
            input.onReasoningDelta?.(part.thinking);
          }
        }
        continue;
      }

      if (raw.type === 'result') {
        const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
        if (subtype && subtype !== 'success') {
          modelError = errorMessage(raw.error ?? raw);
        }

        const totalCost = typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined;
        usage = {
          ...(typeof raw.duration_ms === 'number' ? { durationMs: raw.duration_ms } : {}),
          ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
          ...(typeof raw.num_turns === 'number' ? { turns: raw.num_turns } : {}),
        };

        input.onTrajectory?.({
          type: 'status',
          name: 'CodeBuddy 模型调用完成',
          status: modelError ? 'failed' : 'info',
          model,
          details: {
            runtime: 'codebuddy-sdk',
            execution,
            toolCount,
            ...(sessionId ? { sessionId } : {}),
            ...(Object.keys(usage).length ? { usage } : {}),
          },
        });
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    if (message !== 'Turn aborted.') {
      input.onTrajectory?.({
        type: 'error',
        name: 'CodeBuddy SDK Agent 失败',
        status: 'failed',
        model,
        details: {
          error: message,
          execution,
          ...(sessionId ? { sessionId } : {}),
        },
      });
    }
    throw new Error(message, { cause: error });
  } finally {
    if (input.turnId) activeCodeBuddyTurns.delete(input.turnId);
  }

  if (modelError) throw new Error(modelError);
  if (!answer.trim()) {
    throw new Error('CodeBuddy SDK 没有返回文本答案。');
  }

  if (graphifyRequired && !graphifyUsedRef.value) {
    throw new Error('结构调查前置检查失败：CodeBuddy 没有先使用 Graphify。');
  }

  return {
    answer: answer.trim(),
    sessionId,
    toolCount,
    graphifyUsed: graphifyUsedRef.value,
    ...(usage && Object.keys(usage).length ? { usage } : {}),
  };
}

/**
 * 执行 CodeBuddy Agent。
 *
 * CodeBuddy SDK 的 query() 默认是隔离运行环境；本项目显式注入 cwd、MCP、
 * 权限和任务指令；同一 Runtime/model 的下一阶段通过 query({ resume })
 * 继续 CodeBuddy Session。
 */
export async function askCodeBuddy(
  input: AskInput & { runtime?: AgentRuntime },
  model: string,
): Promise<string> {
  const graphifyEnabled = input.purpose !== 'journey-map'
    && input.purpose !== 'review'
    && Boolean(input.platformCapabilities?.find((item) => item.name === 'graphify-structural-analysis')?.enabled ?? true);

  const mcpServers = toCodeBuddyMcpServers(
    input.mcpServers as unknown as McpServerSetting[] ?? [],
  );

  if (input.purpose !== 'journey-map' && input.purpose !== 'review' && input.investigationName) {
    const workbench = buildCodeBuddyWorkbenchServer(input.investigationName);
    mcpServers.workbench = workbench;
  }

  if (graphifyEnabled) {
    await ensureGraphifyGraph(input.workingDirectory ?? process.cwd(), false);
    const graphify = buildGraphifyMcpServer(input.workingDirectory ?? process.cwd());
    if (graphify) {
      mcpServers[GRAPHIFY_MCP_NAME] = {
        type: 'stdio',
        command: graphify.server.command,
        ...(graphify.server.args.length ? { args: graphify.server.args } : {}),
      };
    }
  }

  let currentPrompt = input.prompt;
  let currentWorkflowInstruction = input.workflowSkill && input.investigationName
    ? await buildJourneyAgentInstruction(input.investigationName, input.workflowSkill).catch(() => '')
    : '';
  let finalAnswer = '';

  const requestedAutomaticContinuations = Math.min(
    6,
    Math.max(0, Math.round(input.autoContinuationTurns ?? 0)),
  );
  const graphifyRequired = graphifyEnabled && requiresGraphifyPrompt(input.prompt);
  const maxAutomaticContinuations = graphifyRequired
    ? Math.min(6, requestedAutomaticContinuations + 1)
    : requestedAutomaticContinuations;

  let lastStageAnswer = '';
  for (let execution = 0; execution <= maxAutomaticContinuations; execution += 1) {
    if (input.shouldAbort?.()) throw new Error('Turn aborted.');

    const preflight = execution === 0 && graphifyRequired;
    if (execution > 0) {
      input.onStatus?.('CodeBuddy 已完成前一阶段，正在继续调查（第 ' + (execution + 1) + ' 阶段）…');
    }

    const prompt = [
      ...(preflight
        ? [
            '这是结构调查的前置步骤。',
            '先使用 Graphify MCP 完成结构导航；至少执行一次 Graphify 查询。',
            '这一轮不要回答最终问题；完成 Graphify 导航后返回关键节点和关系。',
          ]
        : []),
      ...(lastStageAnswer
        ? [
            '上一阶段已经完成。请在不重复已经完成工作的前提下继续当前 Mission。',
            '上一阶段结果如下：',
            lastStageAnswer,
          ]
        : []),
      currentPrompt,
    ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');

    const result = await runCodeBuddyQuery(
      input,
      model,
      prompt,
      currentWorkflowInstruction,
      mcpServers,
      execution,
      graphifyEnabled,
      preflight,
      graphifyRequired,
    );

    if (preflight) {
      lastStageAnswer = result.answer;
      input.onTrajectory?.({
        type: 'status',
        name: 'Graphify 结构分析前置检查完成',
        status: 'completed',
        model,
        details: {
          execution,
          sessionId: result.sessionId,
        },
      });
      currentPrompt = input.prompt;
      continue;
    }

    finalAnswer = result.answer;
    lastStageAnswer = finalAnswer;

    if (input.onBeforeWorkflowTransition) {
      await input.onBeforeWorkflowTransition({ content: finalAnswer, execution });
    }

    const stageGate = await input.onStageResult?.({ content: finalAnswer, execution });
    const workflowTransition =
      stageGate && 'passed' in stageGate && stageGate.passed === false
        ? {
            applied: false,
            error: stageGate.error ?? 'Stage Gate 未通过，当前 Workflow 保持不变。',
            execution: undefined,
          }
        : input.workflowSkill && input.investigationName
          ? await applyAgentWorkflowTransition(
              input.investigationName,
              input.workflowSkill,
              finalAnswer,
              { persistModernizationResult: false },
            )
          : { applied: false, error: undefined, execution: undefined };

    if (workflowTransition.error) {
      input.onStatus?.('CodeBuddy 本阶段没有通过 Workflow Gate，继续补齐结果。');
    }

    if (execution >= maxAutomaticContinuations) break;
    if (workflowTransition.applied && workflowTransition.execution?.status === 'waiting') break;

    const shouldContinue = input.shouldContinueMission
      ? await input.shouldContinueMission()
      : Boolean(stageGate && 'passed' in stageGate ? stageGate.passed !== false : true);
    if (!shouldContinue) break;

    if (input.refreshMissionPrompt) {
      const refreshed = await input.refreshMissionPrompt();
      currentPrompt = [
        '重新检查本次 Mission 的任务目的和期望结果，再决定下一阶段做什么。',
        refreshed,
        '上一阶段的结果如下：',
        finalAnswer,
        '只做直接服务于 Mission 剩余交付物的工作；能通过现有工具、代码、SQL、配置、文档或 Skill 完成的就直接执行，不要只给建议。',
        ...(workflowTransition.error ? ['', '上一阶段 Gate 没通过：', workflowTransition.error] : []),
      ].filter(Boolean).join('\n');
    } else {
      currentPrompt = [
        '继续自主推进当前 Investigation。',
        input.missionPrompt ?? '',
        '上一阶段的结果如下：',
        finalAnswer,
        ...(workflowTransition.error ? ['', '上一阶段 Gate 没通过：', workflowTransition.error] : []),
      ].filter(Boolean).join('\n');
    }

    if (input.workflowSkill && input.investigationName) {
      currentWorkflowInstruction = await buildJourneyAgentInstruction(
        input.investigationName,
        input.workflowSkill,
      ).catch(() => currentWorkflowInstruction);
    }
  }

  input.onTrajectory?.({
    type: 'assistant_turn_end',
    name: 'CodeBuddy SDK Agent 完成',
    status: 'completed',
    model,
    details: {
      runtime: 'codebuddy-sdk',
      model,
      automaticContinuations: maxAutomaticContinuations,
    },
  });

  return finalAnswer;
}
