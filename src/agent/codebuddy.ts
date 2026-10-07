/**
 * CodeBuddy Agent SDK runtime adapter.
 *
 * CodeBuddy SDK runs in an isolated SDK environment by default. This adapter
 * explicitly supplies the Investigation working directory, MCP capability,
 * permission policy and prompt so the surrounding application remains the
 * owner of Mission / Evidence / Workflow state.
 */
import { query, AbortError } from '@tencent-ai/agent-sdk';
import {
  GRAPHIFY_MCP_NAME,
  GRAPHIFY_SELECTION_INSTRUCTION,
  buildGraphifyMcpServer,
  ensureGraphifyGraph,
  isGraphifyTool,
} from '../adapters/graphify.js';
import type { AgentRuntime } from '../investigation/schemas.js';
import type { McpServerSetting } from '../investigation/schemas.js';
import type { AskInput } from './copilot.js';

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

function buildPrompt(input: Pick<AskInput, 'missionPrompt' | 'systemPrompt'>, prompt: string, workflowInstruction: string, graphifyEnabled: boolean): string {
  return [
    input.missionPrompt,
    input.systemPrompt,
    graphifyEnabled ? GRAPHIFY_SELECTION_INSTRUCTION : '',
    workflowInstruction,
    '当前用户任务：',
    prompt,
  ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
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

/**
 * 执行 CodeBuddy Agent。
 *
 * 当前先采用 query() 单轮 API，因为它同时支持 cwd / model / permissionMode /
 * mcpServers；自动续跑由 runtime 层复用 sessionId（CodeBuddy SDK 支持 resume）。
 */
export async function askCodeBuddy(
  input: AskInput & { runtime?: AgentRuntime },
  model: string,
  execution = 0,
): Promise<string> {
  const graphifyEnabled = input.purpose !== 'journey-map'
    && input.purpose !== 'review'
    && Boolean(input.platformCapabilities?.find((item) => item.name === 'graphify-structural-analysis')?.enabled ?? true);

  const mcpServers = toCodeBuddyMcpServers(
    input.mcpServers as unknown as McpServerSetting[] ?? [],
  );
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

  const prompt = buildPrompt(
    input,
    input.prompt,
    input.workflowSkill && input.investigationName
      ? ''
      : '',
    graphifyEnabled,
  );

  const queryOptions = {
    model,
    cwd: input.workingDirectory ?? process.cwd(),
    permissionMode: (input.permissionMode ?? 'allow_all') === 'allow_all'
      ? 'bypassPermissions' as const
      : 'default' as const,
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    maxTurns: 20,
    canUseTool: async (
      toolName: string,
      toolInput: unknown,
    ) => {
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
    options: queryOptions,
  });

  let sessionId = input.sessionId ?? '';
  let answer = '';
  let modelError: string | undefined;
  let toolCount = 0;

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
            if (graphifyToolCall) {
              input.onStatus?.('Graphify 正在帮助助手梳理代码结构，请稍候…');
            } else {
              input.onStatus?.('CodeBuddy 正在使用工具 ' + toolName + '，请稍候…');
            }
            input.onTrajectory?.({
              type: 'tool_call',
              name: graphifyToolCall ? 'Graphify 结构分析：' + toolName : 'CodeBuddy 工具：' + toolName,
              status: 'started',
              model,
              details: {
                execution,
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
                tool: toolName,
              },
            });
          } else if ((part.type === 'thinking' || part.type === 'reasoning') && typeof part.thinking === 'string') {
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
        input.onTrajectory?.({
          type: 'status',
          name: 'CodeBuddy 模型调用完成',
          status: modelError ? 'failed' : 'info',
          model,
          details: {
            runtime: 'codebuddy-sdk',
            execution,
            toolCount,
            ...(typeof raw.duration_ms === 'number' ? { durationMs: raw.duration_ms } : {}),
            ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
            ...(typeof raw.num_turns === 'number' ? { turns: raw.num_turns } : {}),
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
        details: { error: message, execution },
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
  return answer.trim();
}
