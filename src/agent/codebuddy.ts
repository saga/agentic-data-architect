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
import type { AgentRuntime } from '../investigation/schemas.js';
import { config } from '../config.js';
import * as z from 'zod';
import { applyAgentWorkflowTransition, buildJourneyAgentInstruction } from '../workflow/journey-editor.js';
import { requestAgentUserInput } from './user-input-bridge.js';
import { createLocalDataTools } from './local-data-tools.js';
import type { AskInput } from './ask-input.js';
import { appendAuditEvent } from '../investigation/control.js';

const activeCodeBuddyTurns = new Map<string, () => Promise<void>>();

const CODEBUDDY_SAFE_BUILTIN_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'Skill',
] as const;

const CODEBUDDY_MUTATING_TOOLS = new Set([
  'Write',
  'Edit',
  'Bash',
  'NotebookEdit',
  'Task',
  'TodoWrite',
  'TodoRead',
]);

/** Investigation 只允许只读 built-in tool；额外能力只能来自当前任务明确注入的 MCP/Workbench。 */
export function isCodeBuddyToolAllowed(toolName: string): boolean {
  const normalized = toolName.trim();
  if (!normalized) return false;
  if (normalized.startsWith('mcp__')) return true;
  if (CODEBUDDY_MUTATING_TOOLS.has(normalized)) return false;
  return CODEBUDDY_SAFE_BUILTIN_TOOLS.includes(
    normalized as typeof CODEBUDDY_SAFE_BUILTIN_TOOLS[number],
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(root, candidate);
  return candidateResolved === rootResolved || candidateResolved.startsWith(rootResolved + path.sep);
}

/** Read/Glob/Grep 的 path 参数也不能逃出 Investigation workspace。 */
function codeBuddyToolInputWithinWorkspace(
  root: string,
  toolName: string,
  toolInput: unknown,
): boolean {
  if (!['Read', 'Glob', 'Grep'].includes(toolName)) return true;
  if (!toolInput || typeof toolInput !== 'object') return true;
  const record = toolInput as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'file_path', 'directory', 'cwd']) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!isPathWithin(root, value)) return false;
  }
  return true;
}

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
  settings: NonNullable<AskInput['mcpServers']>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [configuredName, value] of Object.entries(settings)) {
    if (!value || typeof value !== 'object') continue;

    const server = value as unknown as Record<string, unknown>;
    const name = configuredName.trim();
    if (!name) continue;

    const type = typeof server.type === 'string' ? server.type : '';
    const command = typeof server.command === 'string' ? server.command : '';
    const url = typeof server.url === 'string' ? server.url : '';
    const args = Array.isArray(server.args)
      ? server.args.filter((item): item is string => typeof item === 'string')
      : undefined;
    const headers = server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
      ? Object.fromEntries(
          Object.entries(server.headers).filter(
            ([key, item]) => typeof key === 'string' && typeof item === 'string',
          ),
        )
      : undefined;

    if ((type === 'stdio' || type === 'local') && command) {
      result[name] = {
        type: 'stdio',
        command,
        ...(args?.length ? { args } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      };
      continue;
    }

    if ((type === 'http' || type === 'sse') && url) {
      result[name] = {
        type,
        url,
        ...(args?.length ? { args } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
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
    version: '1.0.0',
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
  } catch (error) {
    console.warn('[codebuddy] Failed to abort the active CodeBuddy turn.', error);
    return false;
  }
}

interface CodeBuddyQueryResult {
  answer: string;
  sessionId: string;
  toolCount: number;
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
): Promise<CodeBuddyQueryResult> {
  let missionActionReviewed = false;

  const workingDirectory = path.resolve(input.workingDirectory ?? process.cwd());
  const workspaceDirectory = path.resolve(config.workspaceDir);
  if (!isPathWithin(workspaceDirectory, workingDirectory)) {
    throw new Error('CodeBuddy Investigation workspace 必须位于应用管理的 workspace 目录内。');
  }

  const queryOptions = {
    model,
    cwd: workingDirectory,
    // Allow All 只表示安全白名单内的 Investigation 工具免逐次确认，
    // 不能升级为对宿主文件和 shell 的写权限。
    permissionMode: 'bypassPermissions' as const,
    tools: [...CODEBUDDY_SAFE_BUILTIN_TOOLS],
    // SDK defaults to no filesystem settings; Workbench explicitly supplies all
    // tools/configuration it wants, so user/project .codebuddy files cannot alter it.
    settingSources: [],
    systemPrompt: [
      input.missionPrompt,
      input.systemPrompt,
      workflowInstruction,
      ...(input.responseSchema
        ? [
            '输出必须是严格合法的 JSON，且必须符合下面的 JSON Schema；不要输出 Markdown 代码围栏或额外说明。',
            JSON.stringify(z.toJSONSchema(input.responseSchema)),
          ]
        : []),
    ].filter(Boolean).join('\n\n'),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    maxTurns: config.codeBuddyMaxTurns,
    canUseTool: async (
      toolName: string,
      toolInput: unknown,
    ) => {
      if (!isCodeBuddyToolAllowed(toolName)) {
        return {
          behavior: 'deny' as const,
          message: '当前 Investigation 运行时不允许使用可修改代码、执行命令或操作宿主环境的工具。',
          interrupt: false,
        };
      }
      if (!codeBuddyToolInputWithinWorkspace(workingDirectory, toolName, toolInput)) {
        return {
          behavior: 'deny' as const,
          message: '当前 Investigation 运行时只能访问自己的研究 workspace，不能访问宿主其它目录。',
          interrupt: false,
        };
      }

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

      if (
        input.missionActionGate
        && !missionActionReviewed
        && !['AskUserQuestion', 'Skill'].includes(toolName)
      ) {
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
        missionActionReviewed = true;
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
      name: '助手开始执行',
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
            input.onStatus?.('CodeBuddy 正在使用工具 ' + toolName + '，请稍候…');
            input.onTrajectory?.({
              type: 'tool_call',
              name: 'CodeBuddy 工具：' + toolName,
              status: 'started',
              model,
              details: {
                execution,
                ...(sessionId ? { sessionId } : {}),
                tool: toolName,
              },
            });
          } else if (part.type === 'tool_result') {
            const toolName = typeof part.name === 'string' ? part.name : '工具';
            const resultRecord = part as Record<string, unknown>;
            const toolFailed =
              resultRecord.is_error === true
              || resultRecord.isError === true
              || typeof resultRecord.error === 'string';
            const toolError = typeof resultRecord.error === 'string'
              ? resultRecord.error
              : undefined;
            if (toolFailed) {
              const toolFailureDetails = {
                turnId: input.turnId,
                execution,
                tool: toolName,
                ...(toolError ? { error: toolError } : {}),
              };
              console.error('[codebuddy] Tool execution failed.', {
                investigationName: input.investigationName,
                ...toolFailureDetails,
              });
              if (input.investigationName) {
                void appendAuditEvent(input.investigationName, {
                  actor: 'system',
                  action: 'agent.tool.failed',
                  summary: 'CodeBuddy 工具调用失败。',
                  details: toolFailureDetails,
                }).catch((auditError) => {
                  console.error('[codebuddy] Failed to persist tool failure audit.', {
                    investigationName: input.investigationName,
                    tool: toolName,
                    error: auditError,
                  });
                });
              }
            }
            input.onTrajectory?.({
              type: 'tool_result',
              name: 'CodeBuddy 工具结果：' + toolName,
              status: toolFailed ? 'failed' : 'completed',
              model,
              details: {
                execution,
                ...(sessionId ? { sessionId } : {}),
                tool: toolName,
                ...(toolFailed ? { error: toolError ?? '工具返回错误。' } : {}),
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
        name: '助手执行失败',
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

  if (modelError) {
    console.error('[codebuddy] Model execution returned an error result.', {
      investigationName: input.investigationName,
      turnId: input.turnId,
      model,
      error: modelError,
      usage,
    });
    throw new Error(modelError);
  }
  if (!answer.trim()) {
    console.error('[codebuddy] Model execution completed without a usable answer.', {
      investigationName: input.investigationName,
      turnId: input.turnId,
      model,
      toolCount,
      usage,
    });
    throw new Error('助手这次没有返回可用结果。请重试；如果连续发生，请查看执行轨迹。');
  }

  return {
    answer: answer.trim(),
    sessionId,
    toolCount,
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
  // CodeBuddy 不再耦合任何具体结构分析实现；结构分析属于独立 capability。
  // 需要时由 Skill/结构分析工具显式使用，不由 Runtime adapter 强制注入。
  const mcpServers = toCodeBuddyMcpServers(input.mcpServers ?? {});

  if (input.purpose !== 'journey-map' && input.purpose !== 'review' && input.investigationName) {
    const workbench = buildCodeBuddyWorkbenchServer(input.investigationName);
    mcpServers.workbench = workbench;
  }

  let currentPrompt = input.prompt;
  let currentWorkflowInstruction = input.workflowSkill && input.investigationName
    ? await buildJourneyAgentInstruction(input.investigationName, input.workflowSkill).catch((error) => {
        console.warn('[codebuddy] Failed to load Workflow instruction; continuing without it.', error);
        return '';
      })
    : '';
  let finalAnswer = '';

  const requestedAutomaticContinuations = Math.min(
    6,
    Math.max(0, Math.round(input.autoContinuationTurns ?? 0)),
  );
  const maxAutomaticContinuations = requestedAutomaticContinuations;

  let lastStageAnswer = '';
  for (let execution = 0; execution <= maxAutomaticContinuations; execution += 1) {
    if (input.shouldAbort?.()) throw new Error('Turn aborted.');

    if (execution > 0) {
      input.onStatus?.('助手已完成前一阶段，正在继续调查（第 ' + (execution + 1) + ' 阶段）…');
    }

    const prompt = [
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
    );

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
            error: stageGate.error ?? '这一阶段还不能继续，当前工作方式保持不变。',
            execution: undefined,
          }
        : input.workflowSkill && input.investigationName
          ? await applyAgentWorkflowTransition(
              input.investigationName,
              input.workflowSkill,
              finalAnswer,
              {
                persistModernizationResult: false,
                ...(stageGate?.passed === true ? { stageValidationPassed: true } : {}),
              },
            )
          : { applied: false, error: undefined, execution: undefined };

    if (workflowTransition.error) {
      input.onStatus?.('这一阶段的结果还不够，助手正在继续补齐。');
    }

    if (execution >= maxAutomaticContinuations) break;
    if (workflowTransition.applied && workflowTransition.execution?.status === 'waiting') break;

    const shouldContinue = input.shouldContinueMission
      ? await input.shouldContinueMission()
      : false;
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
      ).catch((error) => {
        console.warn('[codebuddy] Failed to refresh Workflow instruction; keeping the previous instruction.', error);
        return currentWorkflowInstruction;
      });
    }
  }

  input.onTrajectory?.({
    type: 'assistant_turn_end',
    name: '助手完成这一阶段',
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
