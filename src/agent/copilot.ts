/**
 * Copilot Agent 运行时封装。
 *
 * 这里负责 Copilot SDK 生命周期、Session 创建/恢复、自动技能发现、MCP/工具配置、流式事件和取消。
 * Investigation 的业务状态仍由 workflow / investigation 层负责持久化。
 */
import { CopilotClient, ToolSet, approveAll } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  buildGraphifyMcpServer,
  tryEnsureGraphifyGraph,
  GRAPHIFY_MCP_NAME,
  isGraphifyTool,
  GRAPHIFY_SELECTION_INSTRUCTION,
} from '../adapters/graphify.js';
import { createLocalDataTools } from './local-data-tools.js';
import { applyAgentWorkflowTransition, buildJourneyAgentInstruction } from '../workflow/journey-editor.js';
import { createRunRecorder, type RunRecorder } from '../investigation/run-recorder.js';
import { rejectAllPendingAgentUserInputs, requestAgentUserInput } from './user-input-bridge.js';
import type { AskInput } from './ask-input.js';

// 进程级 CopilotClient。它负责 SDK 生命周期，不保存 Investigation 业务状态。
let client: CopilotClient | null = null;
let starting: Promise<CopilotClient> | null = null;

const SESSION_NOT_FOUND = /session not found|no such session|unknown session|does not exist|has been deleted/i;
const TURN_TIMEOUT = /^(?:Timeout after \d+ms waiting for session\.idle|等待运行结果超过 \d+ms。)$/;
const AGENT_EXECUTION_TIMEOUT = /^(?:Timeout after \d+ms waiting for agent execution|助手执行超过 \d+ms，已停止本轮调查。)$/;
const USER_INPUT_WAIT_TIMEOUT = /^(?:Timeout after \d+ms waiting for user input|等待你的回答超过 \d+ms，这次操作已停止。)$/;
const PERMISSION_WAIT_TIMEOUT = /^(?:Timeout after \d+ms waiting for permission|等待你确认操作超过 \d+ms，这次操作已停止。)$/;
const WORKFLOW_SKILL_NAMES = [
  'legacy-modernization',
  'current-data-architecture',
  'financial-ai-native-architecture',
  'data-architecture-assessment',
];

// Keep the host tool surface intentionally small; the CLI-like runtime provides
// ambient Copilot skills and built-in MCPs, while the workbench adds only tools it needs.
const WORKBENCH_TOOLS = new ToolSet()
  .addBuiltIn(['ask_user', 'task_complete', 'skill', 'grep', 'glob', 'view', 'bash'])
  .addMcp('*');

const MISSION_ACTION_SKIP_TOOLS = new Set(['ask_user', 'task_complete', 'skill']);

/** 这些工具控制对话/能力本身，不代表调查动作；真正的调查工具需要经过首个动作检查。 */
function shouldCheckMissionAction(toolName: string): boolean {
  return !MISSION_ACTION_SKIP_TOOLS.has(toolName);
}

/** 获取并启动进程级 CopilotClient；首次调用启动，后续调用复用。 */
export async function getClient(): Promise<CopilotClient> {
  if (client) return client;
  if (starting) return starting;
  starting = (async () => {
    // Copilot SDK 的运行数据与 Investigation workspace 分开，避免 SDK 自己的日志/状态被当成调查目录。
    const copilotBaseDirectory = path.join(config.dataDir, 'copilot');

    await fs.mkdir(copilotBaseDirectory, { recursive: true });

    const c = new CopilotClient({
      // This app is intentionally a single-user local productivity tool, so use
      // the CLI-like runtime and its ambient Copilot skills/MCPs. Do not reuse
      // this mode unchanged for a shared multi-user server.
      mode: 'copilot-cli',
      baseDirectory: copilotBaseDirectory,
      ...(config.githubToken ? { gitHubToken: config.githubToken, useLoggedInUser: false } : { useLoggedInUser: true }),
    });
    await c.start();
    client = c;
    starting = null;
    return c;
  })().catch((e) => {
    starting = null;
    throw e;
  });
  return starting;
}

/** 停止 CopilotClient 并清理共享运行时状态，供服务退出和测试 teardown 使用。 */
export async function stopClient(): Promise<void> {
  starting = null;
  if (client) {
    try {
      await client.stop();
    } catch (error) {
      console.warn('[copilot] Agent client stop failed during shutdown.', error);
    }
    client = null;
  }

  // 服务退出时不能留下等待中的请求；活动 turn 也必须失效。
  rejectAllPendingAgentUserInputs(new Error('助手服务已经停止。'));
  pendingCopilotPermissions.clear();
  activeSessions.clear();
}

type CreateSessionConfig = Parameters<CopilotClient['createSession']>[0];

/**
 * sessionConfig 用条件 spread 组装，字面量拿不到回调的上下文类型。
 * SDK（1.0.16）没有从包根导出这三个请求类型，用 Parameters 从
 * CreateSessionConfig 派生只会得到 any，所以这里按实际使用的字段声明最小结构。
 * SDK 升级后如果字段对不上，运行时访问到 undefined 会直接暴露，不要静默加字段。
 */
interface McpAuthRequestParam {
  requestId: string;
  serverName: string;
  serverUrl: string;
  reason: string;
}
interface PreToolUseParam {
  toolName: string;
  toolArgs: unknown;
}
interface PendingCopilotPermission {
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
  /** 把前端的“允许一次 / 后续都允许 / 拒绝”转换成 Copilot SDK 权限决定。 */
  respond: (decision: 'approve-once' | 'approve-for-session' | 'reject') => Promise<void>;
}

/** 当前进程中等待用户确认的权限请求；权限是临时运行态，不写入 Investigation 状态文件。 */
const pendingCopilotPermissions = new Map<string, PendingCopilotPermission>();

/** 返回指定 Investigation 当前等待用户处理的权限请求，供前端轮询显示。 */
export function listPendingCopilotPermissions(sessionName: string): Array<Omit<PendingCopilotPermission, 'respond'>> {
  return [...pendingCopilotPermissions.values()]
    .filter((item) => item.sessionName === sessionName)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .map(({ respond: _respond, ...item }) => ({ ...item }));
}

/** 响应指定权限请求；成功后立即从前端待处理列表移除，SDK 随后继续执行工具。 */
export async function respondToCopilotPermission(
  sessionName: string,
  turnId: string,
  requestId: string,
  allowed: boolean,
  scope: 'once' | 'session' = 'once',
): Promise<boolean> {
  const pending = pendingCopilotPermissions.get(requestId);
  if (!pending || pending.sessionName !== sessionName || pending.turnId !== turnId) return false;

  const decision = !allowed
    ? 'reject'
    : scope === 'session'
      ? 'approve-for-session'
      : 'approve-once';

  try {
    await pending.respond(decision);
    pendingCopilotPermissions.delete(requestId);
    return true;
  } catch (error) {
    console.warn('[copilot] Failed to answer the pending permission request.', error);
    return false;
  }
}

async function getSessionUsageMetrics(session: unknown): Promise<Record<string, unknown> | undefined> {
  try {
    const usage = (session as { usage?: { getMetrics?: () => Promise<unknown> } }).usage;
    if (!usage?.getMetrics) return undefined;
    const metrics = await usage.getMetrics();
    return metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : undefined;
  } catch (error) {
    console.warn('[copilot] Unable to read session usage metrics; continuing without the optional usage summary.', error);
    return undefined;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function diffNumber(after: unknown, before: unknown): number | undefined {
  const a = readNumber(after);
  const b = readNumber(before);
  if (a === undefined || b === undefined) return undefined;
  return Math.max(0, a - b);
}

function diffUsageMetrics(
  after: Record<string, unknown> | undefined,
  before: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!after) return undefined;
  const result: Record<string, unknown> = {};
  for (const field of ['totalNanoAiu', 'totalPremiumRequestCost', 'inputTokens', 'outputTokens', 'totalTokens']) {
    const value = diffNumber(after[field], before?.[field]);
    if (value !== undefined) result[field] = value;
  }
  const afterModels = after.modelMetrics;
  const beforeModels = before?.modelMetrics;
  if (afterModels && typeof afterModels === 'object') {
    const models: Record<string, unknown> = {};
    for (const [model, raw] of Object.entries(afterModels as Record<string, unknown>)) {
      const afterModel = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const beforeModel = beforeModels && typeof beforeModels === 'object'
        ? (beforeModels as Record<string, unknown>)[model]
        : undefined;
      const beforeModelObject = beforeModel && typeof beforeModel === 'object'
        ? beforeModel as Record<string, unknown>
        : {};
      const afterUsage = afterModel.usage && typeof afterModel.usage === 'object'
        ? afterModel.usage as Record<string, unknown>
        : {};
      const beforeUsage = beforeModelObject.usage && typeof beforeModelObject.usage === 'object'
        ? beforeModelObject.usage as Record<string, unknown>
        : {};
      const modelDiff: Record<string, unknown> = {};
      for (const field of ['inputTokens', 'outputTokens']) {
        const value = diffNumber(afterUsage[field], beforeUsage[field]);
        if (value !== undefined) modelDiff[field] = value;
      }
      const aiu = diffNumber(afterModel.totalNanoAiu, beforeModelObject.totalNanoAiu);
      if (aiu !== undefined) modelDiff.totalNanoAiu = aiu;
      if (Object.keys(modelDiff).length) models[model] = modelDiff;
    }
    if (Object.keys(models).length) result.models = models;
  }
  return Object.keys(result).length ? result : undefined;
}

/** 把 SDK intent 映射成简短的用户可见状态，不向前端暴露内部 reasoning 文本。 */
function statusFromIntent(intent: string): string {
  const value = intent.toLowerCase();
  if (value.includes('plan')) return '助手正在整理分析步骤，请稍候…';
  if (value.includes('search') || value.includes('find')) return '助手正在查找相关资料，请稍候…';
  if (value.includes('inspect') || value.includes('read')) return '助手正在查看相关资料，请稍候…';
  if (value.includes('analy')) return '助手正在分析已找到的信息，请稍候…';
  if (value.includes('compare')) return '助手正在比较已有结果，请稍候…';
  if (value.includes('review')) return '助手正在检查分析结果，请稍候…';
  return '助手正在处理你的问题，请稍候…';
}

/** 判断指定 turn 是否仍绑定运行中的 Copilot Session。 */
export function hasActiveCopilotTurn(turnId: string): boolean {
  return activeSessions.has(turnId);
}

/** 请求终止指定 turn 对应的 Copilot Session；没有活动 Session 时返回 false。 */
export async function abortCopilotTurn(turnId: string): Promise<boolean> {
  const active = activeSessions.get(turnId);
  if (!active) return false;
  try {
    await active.abort();
    return true;
  } catch (error) {
    console.warn('[copilot] Failed to abort the active Copilot turn.', error);
    return false;
  }
}

/** 创建或恢复 Copilot Session，固定本次配置，注入 Skills/MCP/本地数据工具和执行白名单。 */
export async function askCopilot(input: AskInput): Promise<string> {
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const journeyMapPurpose = input.purpose === 'journey-map';
  const reviewerPurpose = input.purpose === 'review';
  const isolatedPurpose = journeyMapPurpose || reviewerPurpose;
  const investigationName = input.investigationName ?? path.basename(workingDirectory);
  const selectedModel = input.model ?? config.model;
  const workflowInstruction = isolatedPurpose
    ? ''
    : await buildJourneyAgentInstruction(investigationName, input.workflowSkill ?? null);

  // Runtime selection is explicit at the orchestration layer; retain model-prefix
  // routing here only for legacy direct callers.
  const c = await getClient();

  // This application intentionally uses Copilot's default agent. The project
  // config controls reusable Skills; custom agents are only needed when we
  // introduce genuinely different agent roles.
  const graphifyCapability = input.platformCapabilities?.find((item) => item.name === 'graphify-structural-analysis');
  let graphifyEnabled = !isolatedPurpose && config.graphifyEnabled && (graphifyCapability ? graphifyCapability.enabled : true);
  // 工作地图 AI 不依赖 Graphify；只有真正进行 Investigation 时才检查它。
  let graphifyRuntime: Awaited<ReturnType<typeof tryEnsureGraphifyGraph>>['metadata'] | undefined;
  if (graphifyEnabled) {
    const graphifyPreparation = await tryEnsureGraphifyGraph(workingDirectory, false);
    graphifyRuntime = graphifyPreparation.metadata;
    if (!graphifyPreparation.available) {
      graphifyEnabled = false;
      input.onStatus?.(
        '结构分析工具这次没有生成可用结果，助手改用源码工具继续调查。'
        + (graphifyPreparation.error ? '（Graphify：' + graphifyPreparation.error.slice(0, 180) + '）' : ''),
      );
      input.onTrajectory?.({
        type: 'status',
        name: '结构分析工具不可用，已继续调查',
        status: 'info',
        details: {
          capability: GRAPHIFY_MCP_NAME,
          ...(graphifyPreparation.error ? { error: graphifyPreparation.error } : {}),
        },
      });
    }
  }
  const graphifyMcp = graphifyEnabled ? buildGraphifyMcpServer(workingDirectory) : undefined;
  // 用户显式配置的 MCP 优先，避免内置 capability 覆盖用户自己的同名设置。
  const disabledWorkflowSkills = WORKFLOW_SKILL_NAMES.filter((name) => name !== input.workflowSkill);
  const mcpServers = {
    ...(graphifyMcp ? { [graphifyMcp.name]: graphifyMcp.server } : {}),
    ...(input.mcpServers ?? {}),
  };
  // SDK 自己的 wait timeout 只做极长的 transport-level 兜底；业务 timeout 由下面独立 watchdog 管理。
  const SDK_WAIT_GUARD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

  // 必须在 watchdog 闭包初始化前记录 turn 起始时间，避免块级变量先用后声明。
  const turnStartedAt = Date.now();

  // 当前自动续跑阶段；onPreToolUse 会读取它，不需要把 execution 泄漏到 SDK Session 状态。
  let currentExecution = 0;
  let missionActionReviewedExecution = -1;
  let graphifyRequiredExecution = -1;
  let graphifyUsedExecution = -1;

  let copilotSessionId = input.sessionId ?? '';

  const sessionConfig: CreateSessionConfig = {
    model: selectedModel,
    ...(selectedModel === 'auto' && input.autoTier ? { capi: { autoTier: input.autoTier } } : {}),
    // 默认直接 Allow All，避免本地单用户工作台对每个 read/grep/bash 都重复确认。
    // 只有上层显式传 permission 时，才启用逐次人工审批。
    ...((input.permissionMode ?? 'allow_all') === 'allow_all' ? { onPermissionRequest: approveAll } : {}),
    /**
     * 用户配置的 MCP 如果要求 OAuth，本工作台暂时没有内置 OAuth 登录流程。
     * 不能像默认行为一样悄悄把请求丢在那里等待；明确取消，让 Agent 得到可处理的失败结果。
     */
    onMcpAuthRequest: async (request: McpAuthRequestParam) => {
      input.onStatus?.(`MCP ${request.serverName} 需要登录授权，但工作台目前还不能完成 OAuth 登录。请先在 MCP 服务端完成登录，或暂时移除这个 MCP。`);
      input.onTrajectory?.({
        type: 'status',
        name: 'MCP 需要登录授权',
        status: 'failed',
        details: {
          requestId: request.requestId,
          serverName: request.serverName,
          serverUrl: redactTrajectoryValue(request.serverUrl),
          reason: request.reason,
        },
      });
      return { kind: 'cancelled' as const };
    },
    ...((input.missionActionGate || graphifyEnabled) ? {
      hooks: {
        onPreToolUse: async (toolInput: PreToolUseParam) => {
          const argsText = (() => {
            try { return JSON.stringify(toolInput.toolArgs ?? ''); } catch { return String(toolInput.toolArgs ?? ''); }
          })();

          if (graphifyEnabled && toolInput.toolName === 'skill' && /structural-analysis/i.test(argsText)) {
            graphifyRequiredExecution = currentExecution;
            graphifyUsedExecution = -1;
            input.onTrajectory?.({
              type: 'status',
              name: '已启用结构分析，先查看代码关系',
              status: 'started',
              details: { execution: currentExecution, capability: GRAPHIFY_MCP_NAME },
            });
            return;
          }

          if (graphifyEnabled && isGraphifyTool({
            toolName: toolInput.toolName,
            mcpServerName: (toolInput.toolArgs as Record<string, unknown> | undefined)?.mcpServerName,
            mcpToolName: (toolInput.toolArgs as Record<string, unknown> | undefined)?.mcpToolName,
          })) {
            graphifyUsedExecution = currentExecution;
          }

          if (graphifyEnabled
            && graphifyRequiredExecution === currentExecution
            && graphifyUsedExecution !== currentExecution
            && /^(grep|glob|view|bash)$/i.test(toolInput.toolName)
            && !/graphify/i.test(argsText)) {
            input.onTrajectory?.({
              type: 'status',
              name: '先用 Graphify 查看代码关系',
              status: 'info',
              details: { execution: currentExecution, blockedTool: toolInput.toolName },
            });
            return {
              permissionDecision: 'deny',
              permissionDecisionReason: '这次问题需要先用 Graphify 查看代码关系。',
              additionalContext: [
                '这次问题已经进入结构分析。',
                '先调用 Graphify 找到调用链、依赖、上下游或路径，再使用 grep/view/bash 核对原始源码。',
                '不要用多个文本搜索替代 Graphify 的结构查询。',
              ].join('\\n'),
            };
          }

          if (!shouldCheckMissionAction(toolInput.toolName)) return;
          if (missionActionReviewedExecution === currentExecution) return;
          const decision = await input.missionActionGate?.({
            execution: currentExecution,
            toolName: toolInput.toolName,
            toolArgs: toolInput.toolArgs,
          });
          if (!decision) return;
          if (decision.allowed) {
            missionActionReviewedExecution = currentExecution;
            input.onTrajectory?.({
              type: 'status',
              name: 'Mission 行动检查通过',
              status: 'completed',
              details: {
                execution: currentExecution,
                toolName: toolInput.toolName,
                ...(decision.targetDeliverableId ? { targetDeliverableId: decision.targetDeliverableId } : {}),
              },
            });
            return { permissionDecision: 'allow' };
          }
          input.onTrajectory?.({
            type: 'status',
            name: 'Mission 行动被拦截',
            status: 'info',
            details: { execution: currentExecution, toolName: toolInput.toolName, reason: decision.reason },
          });
          return {
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason,
            additionalContext: [
              '这个工具动作被 Mission Action Gate 拦截。',
              '不要重复执行同一个动作，也不要为了完成“继续调查”而随便换一个无关工具。',
              '重新回到 Mission，选择直接服务某个尚未解决交付物、且现在确有必要的动作。',
            ].join('\\n'),
          };
        },
      },
    } : {}),
    /**
     * ask_user 必须由宿主提供异步 handler。
     * SDK 的 user_input.requested 事件只有观测意义；真正让 Agent 停下来等待回答的是这个 Promise。
     */
    onUserInputRequest: async (request: UserInputRequestParam) => {
      pendingUserInputWaits += 1;
      startUserInputWaitTimeout();
      try {
        return await requestAgentUserInput(
          investigationName,
          input.turnId ?? '',
          copilotSessionId,
          {
            question: request.question,
            choices: request.choices ?? [],
            allowFreeform: request.allowFreeform !== false,
          },
          input.onStatus,
          input.onTrajectory,
        );
      } finally {
        pendingUserInputWaits = Math.max(0, pendingUserInputWaits - 1);
        clearUserInputWaitTimeout();
      }
    },
    workingDirectory,
    systemMessage: {
      mode: 'append' as const,
      // Mission 是最高优先级上下文；即使长期 Session 发生 compaction，
    // 服务器每个 turn 都会通过 system message 重新把任务契约放在最前面。
    content: [input.missionPrompt, input.systemPrompt, graphifyEnabled ? GRAPHIFY_SELECTION_INSTRUCTION : '', workflowInstruction].filter(Boolean).join('\\n\\n'),
    },
    skillDirectories: isolatedPurpose ? [] : (input.skillDirectories ?? [config.skillsDir]),
    // Capability Skills stay available for Copilot's automatic task-based selection.
    // Only the other Workflow Skills are disabled so two routes are not mixed.
    disabledSkills: journeyMapPurpose ? WORKFLOW_SKILL_NAMES : disabledWorkflowSkills,
    // Local data tools are app-owned and remain constrained by Dataset Registry + DuckDB guards.
    ...(isolatedPurpose ? {} : { tools: createLocalDataTools(path.basename(workingDirectory)) }),
    availableTools: isolatedPurpose ? new ToolSet() : WORKBENCH_TOOLS,
      ...(Object.keys(mcpServers).length
      ? { mcpServers: mcpServers as CreateSessionConfig['mcpServers'] }
      : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  // A Copilot session is runtime context only. Investigation state and turn
  // lifecycle remain owned by our workspace/SQLite layers.
  const session = input.sessionId
    ? await resumeOrCreate(c, input.sessionId, sessionConfig)
    : await c.createSession(sessionConfig);

  copilotSessionId = session.sessionId;
  input.onSessionId?.(session.sessionId);
  if (input.turnId) {
    activeSessions.set(input.turnId, { sessionId: session.sessionId, abort: () => session.abort() });
  }
  let pendingUserInputWaits = 0;

  /**
   * 三类 timeout 完全独立：
   * - Agent 执行 watchdog：只累计真正执行中的时间；
   * - Permission watchdog：独立等待人工确认；
   * - User-input watchdog：独立等待 ask_user。
   *
   * watchdog 本身不会暂停；它一直运行，只是不把人工等待计入 Agent 执行预算。
   */
  let rejectExecutionTimeout: ((error: Error) => void) | undefined;
  let rejectPermissionTimeout: ((error: Error) => void) | undefined;
  let rejectUserInputTimeout: ((error: Error) => void) | undefined;
  let permissionWaitTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let userInputWaitTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let executionWatchdogId: ReturnType<typeof setInterval> | undefined;
  let executionActiveMs = 0;
  let executionSampleAt = turnStartedAt;

  const executionWaiting = (): boolean => pendingPermissions.size > 0 || pendingUserInputWaits > 0;

  const executionWatchdog = (): void => {
    const now = Date.now();
    if (!executionWaiting()) {
      executionActiveMs += Math.max(0, now - executionSampleAt);
    }
    executionSampleAt = now;

    if (executionActiveMs >= config.turnTimeoutMs && rejectExecutionTimeout) {
      const reject = rejectExecutionTimeout;
      rejectExecutionTimeout = undefined;
      if (executionWatchdogId !== undefined) clearInterval(executionWatchdogId);
      reject(new Error(`Timeout after ${config.turnTimeoutMs}ms waiting for agent execution`));
    }
  };

  const startPermissionWaitTimeout = (): void => {
    if (permissionWaitTimeoutId !== undefined) return;
    permissionWaitTimeoutId = setTimeout(() => {
      rejectPermissionTimeout?.(
        new Error(`Timeout after ${config.permissionWaitTimeoutMs}ms waiting for permission`),
      );
    }, config.permissionWaitTimeoutMs);
    permissionWaitTimeoutId.unref?.();
  };

  const clearPermissionWaitTimeout = (): void => {
    if (pendingPermissions.size > 0) return;
    if (permissionWaitTimeoutId !== undefined) clearTimeout(permissionWaitTimeoutId);
    permissionWaitTimeoutId = undefined;
  };

  const startUserInputWaitTimeout = (): void => {
    if (userInputWaitTimeoutId !== undefined) return;
    userInputWaitTimeoutId = setTimeout(() => {
      rejectUserInputTimeout?.(
        new Error(`Timeout after ${config.userInputWaitTimeoutMs}ms waiting for user input`),
      );
    }, config.userInputWaitTimeoutMs);
    userInputWaitTimeoutId.unref?.();
  };

  const clearUserInputWaitTimeout = (): void => {
    if (pendingUserInputWaits > 0) return;
    if (userInputWaitTimeoutId !== undefined) clearTimeout(userInputWaitTimeoutId);
    userInputWaitTimeoutId = undefined;
  };

  const heartbeat = setInterval(() => {
    input.onTrajectory?.({
      type: 'status',
      name: 'Agent 状态',
      status: 'info',
      details: {
        elapsedMs: Date.now() - turnStartedAt,
        lastActivityAt,
        lastActivityType,
        lastActivity,
        pendingTools: trajectoryToolStarts.size,
        pendingPermissions: pendingPermissions.size,
        pendingUserInputs: pendingUserInputs.size,
        assistantTurnEnded,
        sessionIdleObserved,
        modelCallCount,
      },
    });
  }, 15_000);

  if (input.shouldAbort?.()) {
    await session.abort();
    throw new Error('Turn aborted.');
  }
  try {
    await session.rpc.skills.reload();
  } catch (error) {
    console.warn('[copilot] Skill reload failed; continuing with the existing session state.', error);
  }

  const usageBefore = await getSessionUsageMetrics(session);

  input.onTrajectory?.({
    type: 'turn_start',
    name: 'Agent 本轮开始',
    status: 'started',
    model: selectedModel,
    details: {
      sessionId: session.sessionId,
      ...(input.autoTier ? { autoTier: input.autoTier } : {}),
    },
  });

  let content = '';
  // 运行态诊断只记录“当前在哪一步”，不记录模型隐藏推理正文。
  const trajectoryToolStarts = new Map<string, { startedAt: number; name: string }>();
  const pendingPermissions = new Map<string, { requestedAt: number; kind: string; summary: string }>();
  const pendingUserInputs = new Map<string, { requestedAt: number; question: string }>();
  let lastActivityAt = new Date(turnStartedAt).toISOString();
  let lastActivityType = 'turn_start';
  let lastActivity = 'Agent 本轮开始';
  let assistantTurnEnded = false;
  let sessionIdleObserved = false;
  let modelCallCount = 0;
  let toolCallCount = 0;
  let latestContextTokens: number | undefined;
  let latestContextLimit: number | undefined;
  let latestContextMessages: number | undefined;
  let runOutcome: { status: 'completed' | 'failed' | 'aborted'; error?: string } = { status: 'completed' };
  const runRecorder: RunRecorder | null = input.turnId
    ? await createRunRecorder(investigationName, {
        turnId: input.turnId,
        sessionId: session.sessionId,
        prompt: input.prompt,
        missionPrompt: input.missionPrompt,
        systemPrompt: input.systemPrompt,
        workflowInstruction,
        model: selectedModel,
        ...(input.autoTier ? { autoTier: input.autoTier } : {}),
        workingDirectory,
        workflowSkill: input.workflowSkill ?? null,
        permissionMode: input.permissionMode ?? 'allow_all',
        mcpServers: Object.keys(mcpServers),
      })
    : null;

  const markActivity = (type: string, activity: string) => {
    lastActivityAt = new Date().toISOString();
    lastActivityType = type;
    lastActivity = activity;
  };

  const offAssistantTurnStart = session.on('assistant.turn_start', (e) => {
    assistantTurnEnded = false;
    markActivity('assistant_turn_start', '模型开始处理');
    input.onTrajectory?.({
      type: 'assistant_turn_start',
      name: '模型处理开始',
      status: 'started',
      details: {
        turnId: e.data.turnId,
        ...(typeof e.data.interactionId === 'string' ? { interactionId: e.data.interactionId } : {}),
      },
    });
  });

  const offMessageDelta = session.on('assistant.message_delta', (e) => {
    if (e.data.deltaContent) {
      content += e.data.deltaContent;
      markActivity('assistant.message_delta', '助手正在生成回答');
      input.onDelta?.(e.data.deltaContent);
    }
  });
  const offIntent = session.on('assistant.intent', (e) => {
    const intent = typeof e.data.intent === 'string' ? e.data.intent.trim() : '';
    if (intent) {
      const status = statusFromIntent(intent);
      markActivity('intent', intent);
      input.onStatus?.(status);
      input.onTrajectory?.({ type: 'intent', name: 'Agent 意图', status: 'info', details: { intent, mappedStatus: status } });
    }
  });
  const offReasoning = session.on('assistant.reasoning_delta', (e) => {
    // Copilot SDK 把可展示的 reasoning 以增量事件送到宿主；只转发给当前回答，
    // 不写 trajectory / run recorder，避免把模型内部过程变成长期审计材料。
    const delta = typeof e.data.deltaContent === 'string' ? e.data.deltaContent : '';
    if (!delta) return;
    markActivity('assistant.reasoning', '模型正在分析');
    input.onStatus?.('助手正在分析你的问题，请稍候…');
    input.onReasoningDelta?.(delta);
  });

  const offAssistantTurnEnd = session.on('assistant.turn_end', (e) => {
    assistantTurnEnded = true;
    markActivity('assistant_turn_end', '模型这一轮输出完成，等待 Session 收尾');
    input.onTrajectory?.({
      type: 'assistant_turn_end',
      name: '模型处理完成',
      status: 'completed',
      details: {
        turnId: e.data.turnId,
      },
    });
  });
  if (graphifyRuntime) {
    input.onTrajectory?.({
      type: 'status',
      name: 'Graphify 结构图已准备好',
      status: 'completed',
      details: {
        capability: GRAPHIFY_MCP_NAME,
        graphPath: graphifyRuntime.graphPath,
        ...(graphifyRuntime.packageVersion ? { packageVersion: graphifyRuntime.packageVersion } : {}),
        ...(graphifyRuntime.graphHash ? { graphHash: graphifyRuntime.graphHash } : {}),
      },
    });
    input.onStatus?.('代码结构已经准备好；需要看调用关系时，助手会先使用 Graphify。');
  }
  const offToolStart = session.on('tool.execution_start', (e) => {
    const toolName = typeof e.data.toolName === 'string' ? e.data.toolName.trim() : '';
    const toolCallId = typeof e.data.toolCallId === 'string' ? e.data.toolCallId : toolName;
    const startedAt = Date.now();
    toolCallCount += 1;
    trajectoryToolStarts.set(toolCallId, { startedAt, name: toolName || '工具调用' });
    markActivity('tool_call', '正在调用工具 ' + (toolName || '工具'));
    const graphifyToolCall = isGraphifyTool({
      toolName,
      mcpServerName: e.data.mcpServerName,
      mcpToolName: e.data.mcpToolName,
    });
    if (graphifyToolCall) graphifyUsedExecution = currentExecution;
    input.onStatus?.(
      graphifyToolCall
        ? '助手正在用 Graphify 查看代码结构，请稍候…'
        : toolName ? `助手正在使用工具 ${toolName}，请稍候…` : '助手正在处理相关资料，请稍候…',
    );
    void runRecorder?.write('tool_call', {
      toolCallId,
      toolName,
      mcpServerName: e.data.mcpServerName,
      mcpToolName: e.data.mcpToolName,
      parentToolCallId: e.data.parentToolCallId,
      arguments: e.data.arguments,
    });
    input.onTrajectory?.({
      type: 'tool_call',
      name: `调用工具 #${toolCallCount}: ${toolName || '工具调用'}`,
      status: 'started',
      details: {
        toolCallId,
        startedAt: new Date(startedAt).toISOString(),
        ...(typeof e.data.mcpServerName === 'string' ? { mcpServerName: e.data.mcpServerName } : {}),
        ...(typeof e.data.mcpToolName === 'string' ? { mcpToolName: e.data.mcpToolName } : {}),
        ...(typeof e.data.parentToolCallId === 'string' ? { parentToolCallId: e.data.parentToolCallId } : {}),
        ...(typeof e.agentId === 'string' ? { agentId: e.agentId } : {}),
        ...(e.data.arguments !== undefined ? { arguments: redactTrajectoryValue(e.data.arguments) } : {}),
      },
    });
  });
  const offToolProgress = session.on('tool.execution_progress', (e) => {
    const toolRun = trajectoryToolStarts.get(e.data.toolCallId);
    markActivity('tool_progress', '工具正在运行：' + (toolRun?.name ?? '工具'));
    input.onTrajectory?.({
      type: 'tool_progress',
      name: toolRun?.name ?? '工具进度',
      status: 'info',
      ...(toolRun ? { durationMs: Date.now() - toolRun.startedAt } : {}),
      details: {
        toolCallId: e.data.toolCallId,
        progressMessage: e.data.progressMessage,
      },
    });
  });

  const offToolComplete = session.on('tool.execution_complete', (e) => {
    const toolCallId = typeof e.data.toolCallId === 'string' ? e.data.toolCallId : '';
    const toolRun = trajectoryToolStarts.get(toolCallId);
    const toolName = toolRun?.name ?? '工具调用';
    const durationMs = toolRun ? Date.now() - toolRun.startedAt : undefined;
    const result = e.data.result as unknown as Record<string, unknown> | undefined;
    const resultContent = typeof result?.content === 'string' ? result.content : undefined;
    markActivity('tool_result', '工具返回：' + toolName);
    input.onStatus?.('助手正在整理刚找到的资料，请稍候…');
    input.onTrajectory?.({
      type: 'tool_result',
      name: toolName,
      status: e.data.success === false ? 'failed' : 'completed',
      ...(durationMs !== undefined ? { durationMs } : {}),
      details: {
        toolCallId,
        ...(typeof e.data.model === 'string' ? { model: e.data.model } : {}),
        ...(typeof e.data.isUserRequested === 'boolean' ? { isUserRequested: e.data.isUserRequested } : {}),
        ...(typeof e.data.parentToolCallId === 'string' ? { parentToolCallId: e.data.parentToolCallId } : {}),
        ...(resultContent !== undefined ? {
          resultPreview: redactTrajectoryValue(resultContent),
          resultLength: resultContent.length,
        } : {}),
        ...(result?.detailedContent && typeof result.detailedContent === 'string'
          ? { detailedResultLength: result.detailedContent.length }
          : {}),
        ...(e.data.error !== undefined ? { error: redactTrajectoryValue(e.data.error) } : {}),
        ...(e.data.toolTelemetry !== undefined ? { toolTelemetry: redactTrajectoryValue(e.data.toolTelemetry) } : {}),
      },
    });
    void runRecorder?.write('tool_result', {
      toolCallId,
      toolName,
      success: e.data.success,
      result: e.data.result,
      error: e.data.error,
      toolTelemetry: e.data.toolTelemetry,
    });
    if (toolCallId) trajectoryToolStarts.delete(toolCallId);
  });
  // These events are UI status signals, not model chain-of-thought. Keep them
  // operational so the browser never receives hidden reasoning text.
  const offPermission = session.on('permission.requested', (e) => {
    const requestId = e.data.requestId;
    const request = e.data.permissionRequest as unknown as Record<string, unknown>;
    const kind = typeof request.kind === 'string' ? request.kind : 'unknown';
    const summary =
      (typeof request.intention === 'string' && request.intention.trim()) ||
      (typeof request.fullCommandText === 'string' && request.fullCommandText.trim()) ||
      (typeof request.fileName === 'string' && request.fileName.trim()) ||
      (typeof request.path === 'string' && request.path.trim()) ||
      (typeof request.toolName === 'string' && request.toolName.trim()) ||
      ('需要确认 ' + kind);
    void runRecorder?.write('permission_request', { requestId, permissionRequest: request });
    const managedApprovalRequired = request.managedApprovalRequired === true;
    const autoApproved = (input.permissionMode ?? 'allow_all') === 'allow_all' && !managedApprovalRequired;
    if (!autoApproved) {
      pendingPermissions.set(requestId, { requestedAt: Date.now(), kind, summary });
      startPermissionWaitTimeout();
    }
    // Allow All 仍然要尊重 Copilot/平台要求的 managedApproval；这种请求必须回到人工确认 UI。
    if (!autoApproved) {
      pendingCopilotPermissions.set(requestId, {
        sessionName: investigationName,
        turnId: input.turnId ?? '',
        sessionId: session.sessionId,
        requestId,
        kind,
        requestedAt: new Date().toISOString(),
        ...(typeof request.intention === 'string' ? { intention: request.intention } : {}),
        ...(typeof request.fullCommandText === 'string' ? { fullCommandText: redactTrajectoryValue(request.fullCommandText) as string } : {}),
        ...(typeof request.fileName === 'string' ? { fileName: request.fileName } : {}),
        ...(typeof request.path === 'string' ? { path: request.path } : {}),
        ...(typeof request.serverName === 'string' ? { serverName: request.serverName } : {}),
        ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
        ...(typeof request.toolTitle === 'string' ? { toolTitle: request.toolTitle } : {}),
        ...(typeof request.readOnly === 'boolean' ? { readOnly: request.readOnly } : {}),
        ...(typeof request.managedApprovalRequired === 'boolean' ? { managedApprovalRequired: request.managedApprovalRequired } : {}),
        respond: async (decision) => {
          await session.rpc.permissions.handlePendingPermissionRequest({
            requestId,
            // Copilot SDK 原生支持 approve-for-session，不需要我们自己维护一套“自动允许”状态。
            result: { kind: decision },
          });
        },
      });
    }
    markActivity('permission', autoApproved ? 'Agent 自动批准操作' : '等待确认：' + kind);
    input.onStatus?.(
      autoApproved
        ? 'Agent 正在自动处理权限，请稍候…'
        : '这一步需要你的确认，请在主对话区处理。',
    );
    input.onTrajectory?.({
      type: 'permission',
      name: autoApproved ? '权限自动处理：' + kind : '等待确认：' + kind,
      status: autoApproved ? 'info' : 'waiting',
      details: {
        requestId,
        kind,
        ...(typeof request.toolCallId === 'string' ? { toolCallId: request.toolCallId } : {}),
        ...(typeof request.intention === 'string' ? { intention: request.intention } : {}),
        ...(typeof request.fullCommandText === 'string' ? { fullCommandText: redactTrajectoryValue(request.fullCommandText) } : {}),
        ...(typeof request.fileName === 'string' ? { fileName: request.fileName } : {}),
        ...(typeof request.path === 'string' ? { path: request.path } : {}),
        ...(typeof request.serverName === 'string' ? { serverName: request.serverName } : {}),
        ...(typeof request.toolName === 'string' ? { toolName: request.toolName } : {}),
        ...(typeof request.toolTitle === 'string' ? { toolTitle: request.toolTitle } : {}),
        ...(typeof request.readOnly === 'boolean' ? { readOnly: request.readOnly } : {}),
        ...(typeof request.managedApprovalRequired === 'boolean'
          ? { managedApprovalRequired: request.managedApprovalRequired }
          : {}),
      },
    });
  });

  const offPermissionCompleted = session.on('permission.completed', (e) => {
    const pending = pendingPermissions.get(e.data.requestId);
    const durationMs = pending ? Date.now() - pending.requestedAt : undefined;
    const result = e.data.result as unknown as Record<string, unknown> | undefined;
    pendingPermissions.delete(e.data.requestId);
    clearPermissionWaitTimeout();
    const resultKind = typeof result?.kind === 'string' ? result.kind : undefined;

    // SDK 在 session.abort() 时会给尚未完成的 permission 补发 cancelled。
    // cancelled 不是用户确认，不在轨迹里伪装成“确认已处理”，也不制造一串绿色完成事件。
    if (resultKind === 'cancelled') return;

    const completionLabel = resultKind === 'reject'
      ? '已拒绝操作'
      : resultKind === 'approve-for-session'
        ? '已允许当前会话'
        : resultKind === 'approve-once'
          ? '已允许操作'
          : '确认已处理';
    markActivity('permission_completed', completionLabel);
    input.onTrajectory?.({
      type: 'permission_completed',
      name: completionLabel,
      status: 'completed',
      ...(durationMs !== undefined ? { durationMs } : {}),
      details: {
        requestId: e.data.requestId,
        ...(pending ? { kind: pending.kind, summary: redactTrajectoryValue(pending.summary) } : {}),
        ...(resultKind ? { resultKind } : {}),
      },
    });
  });
  const offCompaction = session.on('session.compaction_start', () => {
    input.onStatus?.('助手正在整理前面的对话内容，请稍候…');
    input.onTrajectory?.({ type: 'compaction', name: '整理上下文', status: 'started' });
  });
  const offCompactionComplete = session.on('session.compaction_complete', (e) => {
    markActivity('compaction', e.data.success === false ? '上下文整理失败' : '上下文整理完成');
    input.onTrajectory?.({
      type: 'compaction',
      name: '整理上下文',
      status: e.data.success === false ? 'failed' : 'completed',
      details: {
        ...(typeof e.data.preCompactionTokens === 'number' ? { preCompactionTokens: e.data.preCompactionTokens } : {}),
        ...(typeof e.data.postCompactionTokens === 'number' ? { postCompactionTokens: e.data.postCompactionTokens } : {}),
        ...(typeof e.data.messagesRemoved === 'number' ? { messagesRemoved: e.data.messagesRemoved } : {}),
        ...(typeof e.data.tokensRemoved === 'number' ? { tokensRemoved: e.data.tokensRemoved } : {}),
        ...(typeof e.data.compactionTokensUsed === 'object' ? { compactionTokensUsed: redactTrajectoryValue(e.data.compactionTokensUsed) } : {}),
        ...(typeof e.data.requestId === 'string' ? { requestId: e.data.requestId } : {}),
        ...(typeof e.data.error === 'string' ? { error: e.data.error } : {}),
      },
    });
  });
  const offUsage = session.on('assistant.usage', (e) => {
    void runRecorder?.write('model_usage', e.data);
    modelCallCount += 1;
    markActivity('model_call', '模型调用 #' + modelCallCount);
    const usageData = e.data as unknown as Record<string, unknown>;
    const event: {
      type: 'model_call';
      name: string;
      status: 'completed';
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      premiumRequestCost?: number;
      durationMs?: number;
      details: Record<string, unknown>;
    } = {
      type: 'model_call',
      name: (input.modelCallName ? input.modelCallName + ' · ' : '') + '模型调用 #' + modelCallCount,
      status: 'completed',
      details: {},
    };
    if (typeof e.data.model === 'string') event.model = e.data.model;
    if (typeof e.data.inputTokens === 'number') event.inputTokens = e.data.inputTokens;
    if (typeof e.data.outputTokens === 'number') event.outputTokens = e.data.outputTokens;
    if (typeof e.data.cost === 'number') event.premiumRequestCost = e.data.cost;
    if (typeof e.data.duration === 'number') event.durationMs = e.data.duration;
    // 缓存命中和推理 token 直接读 SDK 的类型化字段（cacheReadTokens / reasoningTokens），
    // 不要再把整个事件转成 Record 去猜字段名——那些字段在 SDK 里根本不存在。
    if (typeof e.data.cacheReadTokens === 'number') {
      event.details.cachedInputTokens = e.data.cacheReadTokens;
      if (typeof e.data.inputTokens === 'number') {
        event.details.newInputTokens = Math.max(0, e.data.inputTokens - e.data.cacheReadTokens);
      }
    }
    if (typeof e.data.cacheWriteTokens === 'number') event.details.cacheWriteTokens = e.data.cacheWriteTokens;
    if (typeof e.data.reasoningTokens === 'number') event.details.reasoningTokens = e.data.reasoningTokens;
    if (typeof usageData.availableToolCount === 'number') event.details.availableToolCount = usageData.availableToolCount;
    if (typeof e.data.finishReason === 'string') event.details.finishReason = e.data.finishReason;
    if (typeof e.data.reasoningEffort === 'string') event.details.reasoningEffort = e.data.reasoningEffort;
    if (typeof e.data.timeToFirstTokenMs === 'number') event.details.timeToFirstTokenMs = e.data.timeToFirstTokenMs;
    if (typeof e.data.interTokenLatencyMs === 'number') event.details.interTokenLatencyMs = e.data.interTokenLatencyMs;
    if (typeof e.data.apiEndpoint === 'string') event.details.apiEndpoint = e.data.apiEndpoint;
    if (typeof e.data.apiCallId === 'string') event.details.apiCallId = e.data.apiCallId;
    if (typeof e.data.providerCallId === 'string') event.details.providerCallId = e.data.providerCallId;
    if (typeof e.data.serviceRequestId === 'string') event.details.serviceRequestId = e.data.serviceRequestId;
    if (typeof e.data.initiator === 'string') event.details.initiator = e.data.initiator;
    if (latestContextTokens !== undefined) event.details.contextTokensAtCall = latestContextTokens;
    if (latestContextLimit !== undefined) {
      event.details.contextTokenLimitAtCall = latestContextLimit;
      event.details.contextPercentAtCall = Math.round(latestContextTokens! / latestContextLimit * 100);
    }
    if (latestContextMessages !== undefined) event.details.contextMessagesAtCall = latestContextMessages;
    input.onTrajectory?.(event);
  });
  const offUsageInfo = session.on('session.usage_info', (e) => {
    latestContextTokens = e.data.currentTokens;
    latestContextLimit = e.data.tokenLimit;
    latestContextMessages = e.data.messagesLength;
    const percent = e.data.tokenLimit > 0
      ? Math.round((e.data.currentTokens / e.data.tokenLimit) * 100)
      : undefined;
    markActivity('session.usage_info', '上下文占用 ' + (percent !== undefined ? percent + '%' : ''));
    input.onTrajectory?.({
      type: 'status',
      name: '上下文占用',
      status: 'info',
      details: {
        currentTokens: e.data.currentTokens,
        tokenLimit: e.data.tokenLimit,
        messagesLength: e.data.messagesLength,
        ...(percent !== undefined ? { percent } : {}),
      },
    });
  });

  const offUserInputRequested = session.on('user_input.requested', (e) => {
    pendingUserInputs.set(e.data.requestId, { requestedAt: Date.now(), question: e.data.question });
    markActivity('user_input_requested', '等待用户输入');
    input.onStatus?.('助手正在等你的输入。');
    // ask_user 的真正等待由 onUserInputRequest handler 实现；这里仅补充 SDK runtime requestId，
    // 方便轨迹中的 user_input.completed 与本轮执行对应。
    void runRecorder?.write('user_input_request', {
      requestId: e.data.requestId,
      question: e.data.question,
      choices: e.data.choices,
      allowFreeform: e.data.allowFreeform,
    });
    input.onTrajectory?.({
      type: 'user_input_requested',
      name: 'Agent 请求用户输入',
      status: 'waiting',
      details: {
        // 轨迹必须保存 SDK 的 runtime requestId，才能和 user_input.completed 对上。
        requestId: e.data.requestId,
        question: redactTrajectoryValue(e.data.question),
        ...(e.data.choices?.length ? { choices: redactTrajectoryValue(e.data.choices) } : {}),
        ...(typeof e.data.allowFreeform === 'boolean' ? { allowFreeform: e.data.allowFreeform } : {}),
      },
    });
  });

  const offUserInputCompleted = session.on('user_input.completed', (e) => {
    void runRecorder?.write('user_input_completed', e.data);
    const pending = pendingUserInputs.get(e.data.requestId);
    const durationMs = pending ? Date.now() - pending.requestedAt : undefined;
    pendingUserInputs.delete(e.data.requestId);
    markActivity('user_input_completed', '用户输入已提供');
    input.onTrajectory?.({
      type: 'user_input_completed',
      name: '用户输入已提供',
      status: 'completed',
      ...(durationMs !== undefined ? { durationMs } : {}),
      details: {
        requestId: e.data.requestId,
        ...(pending ? { question: redactTrajectoryValue(pending.question) } : {}),
      },
    });
  });

  const offSessionIdle = session.on('session.idle', (e) => {
    sessionIdleObserved = true;
    markActivity('session_idle', e.data.aborted ? 'Session 已结束（已中止）' : 'Session 已进入 idle');
    input.onTrajectory?.({
      type: 'session_idle',
      name: e.data.aborted ? 'Session 已中止' : 'Session 已 idle',
      status: e.data.aborted ? 'info' : 'completed',
      details: {
        aborted: e.data.aborted,
        pendingTools: trajectoryToolStarts.size,
        pendingPermissions: pendingPermissions.size,
        pendingUserInputs: pendingUserInputs.size,
      },
    });
  });

  const offSessionError = session.on('session.error', (e) => {
    void runRecorder?.write('session_error', e.data);
    markActivity('session_error', '助手运行出错：' + e.data.message);
    input.onTrajectory?.({
      type: 'session_error',
      name: '助手运行出错',
      status: 'failed',
      details: {
        errorType: e.data.errorType,
        message: e.data.message,
        ...(typeof e.data.statusCode === 'number' ? { statusCode: e.data.statusCode } : {}),
        ...(typeof e.data.providerCallId === 'string' ? { providerCallId: e.data.providerCallId } : {}),
      },
    });
  });

  const offContextChanged = session.on('session.context_changed', (e) => {
    markActivity('context_changed', '运行目录/仓库上下文发生变化');
    input.onTrajectory?.({
      type: 'context_changed',
      name: '运行上下文变化',
      status: 'info',
      details: {
        cwd: e.data.cwd,
        ...(typeof e.data.gitRoot === 'string' ? { gitRoot: e.data.gitRoot } : {}),
        ...(typeof e.data.repository === 'string' ? { repository: e.data.repository } : {}),
        ...(typeof e.data.branch === 'string' ? { branch: e.data.branch } : {}),
      },
    });
  });

  // 6 分钟执行 watchdog 从整个 Agent turn 开始持续运行；它只累计非人工等待时间。
  executionWatchdogId = setInterval(executionWatchdog, 250);
  executionWatchdogId.unref?.();

  try {
    if (input.shouldAbort?.()) {
      await session.abort();
      throw new Error('Turn aborted.');
    }

    /**
     * 一个用户问题默认不再只对应一次 Copilot sendAndWait。
     *
     * Copilot SDK 的 Session 会在 Agent 自己认为“这一轮完成”后进入 idle；
     * 这并不代表 Investigation 的目标已经完成。以前这里一次 sendAndWait
     * 返回就直接结束整个 Investigation turn，所以 Agent 很容易查一两步
     * 就把“下一步”交给用户。
     *
     * 首轮结束后是否继续、继续多少阶段由 Investigation 配置决定。仍然复用
     * 同一个 Session，因此上下文、工具、Skills 和已经找到的资料都保留；如果
     * Agent 真正需要用户选择/输入/权限，SDK 仍然会在 sendAndWait 内等待，
     * 不会绕过人工控制。
     *
     * 运行时仍保留 6 次自动续跑的硬上限，防止配置异常导致无限循环；UI 正常
     * 只提供这个范围内的选项。
     */
    const autoContinuationTurns = Math.min(6, Math.max(0, Math.round(input.autoContinuationTurns ?? 0)));
    let finalContent = '';
    let continuationPrompt = input.prompt;
    let currentWorkflowInstruction = workflowInstruction;

    for (let execution = 0; execution <= autoContinuationTurns; execution += 1) {
      currentExecution = execution;
      missionActionReviewedExecution = -1;

      if (input.shouldAbort?.()) {
        await session.abort();
        throw new Error('Turn aborted.');
      }

      content = '';
      await runRecorder?.write('agent_request', {
        execution,
        prompt: continuationPrompt,
        missionPrompt: input.missionPrompt,
        workflowInstruction: currentWorkflowInstruction,
      });
      if (execution > 0) {
        input.onStatus?.(`助手已完成前一阶段，正在自主继续调查（第 ${execution + 1} 阶段）…`);
        input.onTrajectory?.({
          type: 'status',
          name: `自主继续调查 #${execution}`,
          status: 'started',
          details: {
            execution,
            maxAutomaticContinuations: autoContinuationTurns,
          },
        });
      }

      executionSampleAt = Date.now();
      executionActiveMs = 0;

      const executionTimeoutPromise = new Promise<never>((_, reject) => {
        rejectExecutionTimeout = reject;
      });
      const permissionTimeoutPromise = new Promise<never>((_, reject) => {
        rejectPermissionTimeout = reject;
      });
      const userInputTimeoutPromise = new Promise<never>((_, reject) => {
        rejectUserInputTimeout = reject;
      });

      let final;
      try {
        final = await Promise.race([
          session.sendAndWait(
            {
              prompt: continuationPrompt,
              ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
            },
            SDK_WAIT_GUARD_TIMEOUT_MS,
          ),
          executionTimeoutPromise,
          permissionTimeoutPromise,
          userInputTimeoutPromise,
        ]);
      } catch (error) {
        if (error instanceof Error && (
          AGENT_EXECUTION_TIMEOUT.test(error.message)
          || USER_INPUT_WAIT_TIMEOUT.test(error.message)
          || PERMISSION_WAIT_TIMEOUT.test(error.message)
        )) {
          try {
            await session.abort();
          } catch (abortError) {
            console.warn('[copilot] Failed to abort the session after a watchdog timeout.', abortError);
          }
        }
        throw error;
      } finally {
        rejectExecutionTimeout = undefined;
        rejectPermissionTimeout = undefined;
        rejectUserInputTimeout = undefined;
      }
      finalContent = final?.data.content || content;

      // 先保存本阶段应该落盘的业务成果，再执行 Workflow transition / Gate。
      // Stage Script Gate 随后读取的是已经持久化的真实状态，而不是模型口中的“我做完了”。
      if (input.onBeforeWorkflowTransition) {
        await input.onBeforeWorkflowTransition({ content: finalContent, execution });
      }

      // Stage Gate 必须先于 Workflow transition。
      // 这样 Agent 的“success”只有在真实成果和 Mission 对齐检查通过后才能改变 Workflow 位置。
      const stageGateDecision = await input.onStageResult?.({ content: finalContent, execution });
      const workflowTransition =
        stageGateDecision && 'passed' in stageGateDecision && stageGateDecision.passed === false
          ? {
              applied: false,
              error: stageGateDecision.error ?? 'Stage Gate 未通过，当前 Workflow 保持不变。',
              execution: undefined,
            }
          : await applyAgentWorkflowTransition(
              investigationName,
              input.workflowSkill ?? null,
              finalContent,
              {
                persistModernizationResult: false,
                ...(stageGateDecision?.passed === true ? { stageValidationPassed: true } : {}),
              },
            );

      await runRecorder?.write('model_response', {
        execution,
        response: finalContent,
        sessionTurnId: final?.data.turnId,
      });

      if (workflowTransition.error) {
        input.onTrajectory?.({
          type: 'status',
          name: 'Workflow transition 未应用',
          status: 'info',
          details: { error: workflowTransition.error, execution },
        });
      }

      if (execution < autoContinuationTurns) {
        // Workflow 已经走到终点时，这次 Completion Review 的结果直接复用到下面，
        // 避免同一个阶段连续调用两次相同的 Smart Function。
        let missionNeedsContinuation: boolean | undefined;
        const workflowCompleted =
          workflowTransition.applied && workflowTransition.execution?.status === 'completed';

        if (workflowCompleted) {
          /**
           * Workflow 的 completed 只是某个路线节点已经结束。
           * Mission 是否真的完成仍由上层 Completion Gate 决定；否则一个固定 Workflow
           * 很容易把“阶段做完”错误地当成“用户最终结果已经拿到”。
           */
          missionNeedsContinuation = input.shouldContinueMission
            ? await input.shouldContinueMission()
            : false;
          if (!missionNeedsContinuation) {
            break;
          }
          // Workflow 已经没有下一节点，但 Mission 还有缺口：继续自主调查，不再注入完成态 Workflow 指令。
          currentWorkflowInstruction = '';
        }

        if (workflowTransition.applied && workflowTransition.execution?.status === 'waiting') {
          break;
        }

        if (workflowTransition.applied && input.workflowSkill && !workflowCompleted) {
          try {
            currentWorkflowInstruction = await buildJourneyAgentInstruction(
              investigationName,
              input.workflowSkill,
            );
          } catch (error) {
            console.warn('[copilot] Failed to refresh Workflow instruction; continuing with the existing instruction.', error);
          }
        }

        const shouldContinueMission = missionNeedsContinuation
          ?? (input.shouldContinueMission ? await input.shouldContinueMission() : false);
        if (!shouldContinueMission) {
          input.onStatus?.('Mission 需要的交付物已经覆盖，停止自动续跑。');
          input.onTrajectory?.({
            type: 'status',
            name: 'Mission 交付物已覆盖，停止自动续跑',
            status: 'completed',
            details: { execution },
          });
          break;
        }

        const refreshedMissionPrompt = input.refreshMissionPrompt
          ? await input.refreshMissionPrompt()
          : input.missionPrompt;

        continuationPrompt = [
          ...(refreshedMissionPrompt
            ? [
                '## Mission Contract（每一阶段重新确认，最高优先级）',
                refreshedMissionPrompt,
                '先重新回答两个问题，再开始下一阶段：为什么做这次调查？最后希望拿到什么？',
              ]
            : []),
          '继续自主推进当前 Investigation，但只做直接服务于 Mission 的工作；不要因为上一阶段产生了局部发现就自动寻找另一个“关键问题”。',
          ...(workflowTransition.error ? [
            '',
            '上一阶段尝试完成，但服务端的确定性 Script Gate 没有通过：',
            workflowTransition.error,
            '不要再次只返回 workflow.success。继续当前阶段，补齐缺少的真实工作成果、Evidence 或实际验证结果。',
          ] : []),
          '重新检查当前 Mission 的任务目的、期望结果和每个交付物覆盖情况，再决定本阶段做什么。',
          '如果某条调查路径受阻、缺少运行环境或暂时无法验证，不要把这条路径本身变成任务；换到其它仍然直接服务 Mission 的方向。',
          '优先补齐尚未覆盖的核心交付物，再深入已经基本完成的局部细节。',
          '如果一个 unknown 不影响 Mission 的期望结果，不要因为它存在而继续调查。',
          '能通过现有工具、代码、SQL、配置、文档或 Skill 完成的工作，直接执行，不要把它写成“下一步建议”交给用户。',
          '只有确实需要用户作决定、补充缺失输入、处理权限，或者 Mission 的剩余交付物已经没有有价值的调查动作时，才结束这一阶段。',
          '如果 Mission 已经得到足够支持，直接结束，不要为了延长运行而虚构工作。',
          ...(currentWorkflowInstruction ? [
            '',
            '当前 Workflow 最新位置（如果本阶段刚刚推进了地图，以这个位置为准）：',
            currentWorkflowInstruction,
          ] : []),
        ].join('\n');
      }
    }
    const usageAfter = await getSessionUsageMetrics(session);
    const turnUsage = diffUsageMetrics(usageAfter, usageBefore);
    markActivity('turn_end', 'Agent 本轮结束');
    input.onTrajectory?.({
      type: 'turn_end',
      name: 'Agent 本轮结束',
      status: 'completed',
      details: {
        ...(turnUsage ? { turnUsage: redactTrajectoryValue(turnUsage) } : {}),
        elapsedMs: Date.now() - turnStartedAt,
        modelCallCount,
        sessionIdleObserved,
      },
    });
    return finalContent;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const sdkTimedOut = TURN_TIMEOUT.test(errorMessage);
    const executionTimedOut = AGENT_EXECUTION_TIMEOUT.test(errorMessage);
    const userInputTimedOut = USER_INPUT_WAIT_TIMEOUT.test(errorMessage);
    const permissionTimedOut = PERMISSION_WAIT_TIMEOUT.test(errorMessage);
    const timedOut = sdkTimedOut || executionTimedOut || userInputTimedOut || permissionTimedOut;
    const timeoutLabel = permissionTimedOut
      ? '等待用户确认时间过长'
      : userInputTimedOut
        ? '等待用户回答时间过长'
        : executionTimedOut
        ? '助手执行时间过长'
        : sdkTimedOut
          ? '等待运行结果时间过长'
          : '';
    runOutcome = {
      status: timedOut || /abort/i.test(errorMessage) ? 'aborted' : 'failed',
      error: errorMessage,
    };
    markActivity(timedOut ? 'timeout' : 'error', timedOut ? timeoutLabel : '助手执行失败');
    input.onTrajectory?.({
      type: 'error',
      name: timedOut
        ? timeoutLabel
        : '助手执行失败',
      status: 'failed',
      details: {
        error: errorMessage,
        elapsedMs: Date.now() - turnStartedAt,
        timeoutMs: permissionTimedOut
          ? config.permissionWaitTimeoutMs
          : executionTimedOut
            ? config.turnTimeoutMs
            : sdkTimedOut
              ? Math.max(config.turnTimeoutMs, config.userInputWaitTimeoutMs, config.permissionWaitTimeoutMs)
              : undefined,
        ...(permissionTimedOut ? { permissionWaitTimeoutMs: config.permissionWaitTimeoutMs } : {}),
        ...(userInputTimedOut ? { userInputWaitTimeoutMs: config.userInputWaitTimeoutMs } : {}),
        ...(timedOut ? {
          timeoutKind: permissionTimedOut
            ? 'permission'
            : userInputTimedOut
              ? 'user_input'
              : sdkTimedOut
                ? 'session_idle'
                : 'execution',
        } : {}),
        lastActivityAt,
        lastActivityType,
        lastActivity,
        pendingTools: trajectoryToolStarts.size,
        pendingPermissions: pendingPermissions.size,
        pendingUserInputs: pendingUserInputs.size,
        assistantTurnEnded,
        sessionIdleObserved,
        modelCallCount,
        ...(pendingPermissions.size ? {
          permissions: [...pendingPermissions.entries()].map(([requestId, item]) => ({
            requestId,
            kind: item.kind,
            requestedAt: new Date(item.requestedAt).toISOString(),
            summary: redactTrajectoryValue(item.summary),
          })),
        } : {}),
      },
    });
    if (timedOut) {
      try {
        await session.abort();
      } catch (error) {
        console.warn('[copilot] Failed to abort the timed-out session.', error);
      }
    }
    throw e;
  } finally {
    try {
      await runRecorder?.write('run_finished', {
        elapsedMs: Date.now() - turnStartedAt,
        status: runOutcome.status,
        ...(runOutcome.error ? { error: runOutcome.error } : {}),
      });
      await runRecorder?.close(runOutcome);
    } catch (error) {
      console.error('[copilot] Failed to persist runtime execution record.', error);
    }
    clearInterval(heartbeat);
    if (executionWatchdogId !== undefined) clearInterval(executionWatchdogId);
    executionWatchdogId = undefined;
    if (permissionWaitTimeoutId !== undefined) clearTimeout(permissionWaitTimeoutId);
    permissionWaitTimeoutId = undefined;
    if (userInputWaitTimeoutId !== undefined) clearTimeout(userInputWaitTimeoutId);
    userInputWaitTimeoutId = undefined;
    rejectExecutionTimeout = undefined;
    rejectPermissionTimeout = undefined;
    rejectUserInputTimeout = undefined;
    for (const [requestId, pending] of pendingCopilotPermissions) {
      if (pending.turnId === (input.turnId ?? '')) pendingCopilotPermissions.delete(requestId);
    }
    if (input.turnId) activeSessions.delete(input.turnId);
    offAssistantTurnStart();
    offMessageDelta();
    offIntent();
    offReasoning();
    offAssistantTurnEnd();
    offToolStart();
    offToolProgress();
    offToolComplete();
    offPermission();
    offPermissionCompleted();
    offUserInputRequested();
    offUserInputCompleted();
    offSessionIdle();
    offSessionError();
    offContextChanged();
    offCompaction();
    offCompactionComplete();
    offUsage();
    offUsageInfo();
    try {
      await session.disconnect();
    } catch (error) {
      console.warn('[copilot] Failed to disconnect the Copilot session.', error);
    }
  }
}

/** 优先恢复已有 Copilot Session；确认 Session 不存在时才创建新的 Session。 */
function redactTrajectoryValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'string' && value.length > 500 ? value.slice(0, 500) + '…' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(redactTrajectoryValue);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source).slice(0, 30)) {
      const lower = key.toLowerCase();
      out[key] = /token|secret|password|authorization|api[-_]?key|cookie/.test(lower)
        ? '[已隐藏]'
        : redactTrajectoryValue(item);
    }
    return out;
  }
  return String(value);
}

async function resumeOrCreate(
  c: CopilotClient,
  sessionId: string,
  sessionConfig: Parameters<CopilotClient['createSession']>[0],
) {
  try {
    return await c.resumeSession(sessionId, sessionConfig);
  } catch (e) {
    if (e instanceof Error && SESSION_NOT_FOUND.test(e.message)) {
      return c.createSession(sessionConfig);
    }
    try {
      if ((await c.getSessionMetadata(sessionId)) === undefined) {
        return c.createSession(sessionConfig);
      }
    } catch (metadataError) {
      console.warn('[copilot] Unable to verify the existing session while recovering it; preserving the original resume error.', metadataError);
    }
    throw e;
  }
}
