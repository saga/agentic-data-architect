/**
 * Copilot Agent 运行时封装。
 *
 * 这里负责 Copilot SDK 生命周期、Session 创建/恢复、Skills/MCP/工具配置、流式事件和取消。
 * Investigation 的业务状态仍由 workflow / investigation 层负责持久化。
 */
import { CopilotClient, ToolSet } from '@github/copilot-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { assertGraphifyRuntimeAvailable, buildGraphifyMcpServer, prepareGraphifyEnvironment } from '../adapters/graphify.js';

// 进程级 CopilotClient。它负责 SDK 生命周期，不保存 Investigation 业务状态。
let client: CopilotClient | null = null;
let starting: Promise<CopilotClient> | null = null;

const SESSION_NOT_FOUND = /session not found|no such session|unknown session|does not exist|has been deleted/i;
const TURN_TIMEOUT = /^Timeout after \d+ms waiting for session\.idle$/;

// Explicitly opt into the host tools this workbench needs. Mode "empty" avoids
// inheriting unrelated Copilot CLI capabilities while still allowing Skills,
// read/search tools, deterministic Skill scripts, and configured MCP servers.
const WORKBENCH_TOOLS = new ToolSet()
  .addBuiltIn(['ask_user', 'task_complete', 'exit_plan_mode', 'skill', 'grep', 'glob', 'view', 'bash'])
  .addMcp('*');

/** 获取并启动进程级 CopilotClient；首次调用启动，后续调用复用。 */
export async function getClient(): Promise<CopilotClient> {
  if (client) return client;
  // Graphify 是平台级 structural-analysis capability；把项目 .venv/bin 放进 PATH，
  // 这样 Skill 中的 graphify 命令与 MCP 使用的是同一份依赖。
  prepareGraphifyEnvironment();
  assertGraphifyRuntimeAvailable();
  if (starting) return starting;
  starting = (async () => {
    // empty 模式不会再默认把 Copilot 状态写到用户家目录。
    // 所有 Investigation 共用这个运行时目录，具体 Session 再由 SDK 按 sessionId 分目录保存。
    // 这样既满足 SDK 的显式持久化要求，也不会让不同 Investigation 共用同一份 Session 状态。
    const copilotBaseDirectory = path.join(config.workspaceDir, 'copilot');
    await fs.mkdir(copilotBaseDirectory, { recursive: true });

    const c = new CopilotClient({
      mode: 'empty',
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
    } catch {
      /* ignore */
    }
    client = null;
  }
}

type CreateSessionConfig = Parameters<CopilotClient['createSession']>[0];

/** 一次 Agent 执行所需的全部输入，以及流式输出、状态、Session 持久化和取消回调。 */
export interface AskInput {
  prompt: string;
  systemPrompt: string;
  /** 记录本轮可展示的 Agent 执行轨迹；不包含思维链正文。 */
  onTrajectory?: (event: {
    type: 'user_input' | 'turn_start' | 'intent' | 'model_call' | 'tool_call' | 'tool_result' | 'permission' | 'compaction' | 'turn_end' | 'error' | 'status';
    name: string;
    status?: 'started' | 'completed' | 'failed' | 'waiting' | 'info';
    durationMs?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    premiumRequestCost?: number;
    details?: Record<string, unknown>;
  }) => void;
  /** When provided, the same resumable Copilot session is reused across turns/processes. */
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  skills?: string[];
  skillDirectories?: string[];
  /** Platform capabilities are fixed by the Control snapshot for this turn. */
  platformCapabilities?: ReadonlyArray<{ name: string; version: number; enabled: boolean }>;
  mcpServers?: NonNullable<CreateSessionConfig['mcpServers']>;
  onDelta?: (delta: string) => void;
  onStatus?: (status: string) => void;
  onSessionId?: (sessionId: string) => void;
  turnId?: string;
  shouldAbort?: () => boolean;
}

// turnId → 当前 Copilot session。用于 Stop、重复请求检测和执行生命周期管理。
const activeSessions = new Map<string, { sessionId: string; abort: () => Promise<void> }>();

async function getSessionUsageMetrics(session: unknown): Promise<Record<string, unknown> | undefined> {
  try {
    const usage = (session as { usage?: { getMetrics?: () => Promise<unknown> } }).usage;
    if (!usage?.getMetrics) return undefined;
    const metrics = await usage.getMetrics();
    return metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : undefined;
  } catch {
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

/** 扫描 Skills 目录并读取 Skill 名称；无效 Skill 目录直接忽略。 */
async function listSkillNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const skillFile = await fs.readFile(path.join(config.skillsDir, entry.name, 'SKILL.md'), 'utf8');
        const name = /^name:\s*(.+)$/m.exec(skillFile)?.[1]?.trim() || entry.name;
        if (name) names.push(name);
      } catch {
        // Ignore invalid skill directories; the SDK will not load them either.
      }
    }
    return [...new Set(names)];
  } catch {
    return [];
  }
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
  } catch {
    return false;
  }
}

/** 创建或恢复 Copilot Session，固定本次配置，注入 Skills/MCP/工具白名单并执行一次请求。 */
export async function askCopilot(input: AskInput): Promise<string> {
  const c = await getClient();

  // This application intentionally uses Copilot's default agent. The project
  // config controls reusable Skills; custom agents are only needed when we
  // introduce genuinely different agent roles.
  const availableSkillNames = await listSkillNames();
  const selectedSkillNames = new Set(input.skills ?? config.copilotSkills);
  const disabledSkills = availableSkillNames.filter((name) => !selectedSkillNames.has(name));

  const workingDirectory = input.workingDirectory ?? process.cwd();
  const graphifyCapability = input.platformCapabilities?.find((item) => item.name === 'graphify-structural-analysis');
  const graphifyEnabled = config.graphifyEnabled && (graphifyCapability ? graphifyCapability.enabled : true);
  const graphifyMcp = graphifyEnabled ? buildGraphifyMcpServer(workingDirectory) : undefined;
  // 用户显式配置的 MCP 优先，避免内置 capability 覆盖用户自己的同名设置。
  const mcpServers = {
    ...(graphifyMcp ? { [graphifyMcp.name]: graphifyMcp.server } : {}),
    ...(input.mcpServers ?? {}),
  };

  const sessionConfig: CreateSessionConfig = {
    model: input.model ?? config.model,
    workingDirectory,
    systemMessage: { mode: 'append' as const, content: input.systemPrompt },
    skillDirectories: input.skillDirectories ?? [config.skillsDir],
    disabledSkills,
    availableTools: WORKBENCH_TOOLS,
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  // A Copilot session is runtime context only. Investigation state and turn
  // lifecycle remain owned by our workspace/SQLite layers.
  const session = input.sessionId
    ? await resumeOrCreate(c, input.sessionId, sessionConfig)
    : await c.createSession(sessionConfig);

  input.onSessionId?.(session.sessionId);
  if (input.turnId) {
    activeSessions.set(input.turnId, { sessionId: session.sessionId, abort: () => session.abort() });
  }
  try {
    if (input.shouldAbort?.()) {
      await session.abort();
      throw new Error('Turn aborted.');
    }
    await session.rpc.skills.reload();
  } catch {
    // Skill reload is best-effort; session creation still works on older runtimes.
  }

  const usageBefore = await getSessionUsageMetrics(session);

  input.onTrajectory?.({
    type: 'turn_start',
    name: 'Agent 本轮开始',
    status: 'started',
    model: input.model ?? config.model,
    details: { sessionId: session.sessionId },
  });

  let content = '';
  const trajectoryToolStarts = new Map<string, { startedAt: number; name: string }>();
  const offMessageDelta = session.on('assistant.message_delta', (e) => {
    if (e.data.deltaContent) {
      content += e.data.deltaContent;
      input.onDelta?.(e.data.deltaContent);
    }
  });
  const offIntent = session.on('assistant.intent', (e) => {
    const intent = typeof e.data.intent === 'string' ? e.data.intent.trim() : '';
    if (intent) {
      input.onStatus?.(statusFromIntent(intent));
      input.onTrajectory?.({ type: 'intent', name: 'Agent 意图', status: 'info', details: { intent } });
    }
  });
  const offReasoning = session.on('assistant.reasoning_delta', () => {
    input.onStatus?.('助手正在分析你的问题，请稍候…');
  });
  const offToolStart = session.on('tool.execution_start', (e) => {
    const toolName = typeof e.data.toolName === 'string' ? e.data.toolName.trim() : '';
    const toolCallId = typeof e.data.toolCallId === 'string' ? e.data.toolCallId : toolName;
    trajectoryToolStarts.set(toolCallId, { startedAt: Date.now(), name: toolName || '工具调用' });
    input.onStatus?.(toolName ? `助手正在使用工具 ${toolName}，请稍候…` : '助手正在处理相关资料，请稍候…');
    input.onTrajectory?.({
      type: 'tool_call',
      name: toolName || '工具调用',
      status: 'started',
      details: {
        toolCallId,
        ...(typeof e.data.mcpServerName === 'string' ? { mcpServerName: e.data.mcpServerName } : {}),
        ...(e.data.arguments !== undefined ? { arguments: redactTrajectoryValue(e.data.arguments) } : {}),
      },
    });
  });
  const offToolComplete = session.on('tool.execution_complete', (e) => {
    const toolCallId = typeof e.data.toolCallId === 'string' ? e.data.toolCallId : '';
    const toolRun = trajectoryToolStarts.get(toolCallId);
    const toolName = toolRun?.name ?? '工具调用';
    input.onStatus?.('助手正在整理刚找到的资料，请稍候…');
    input.onTrajectory?.({
      type: 'tool_result',
      name: toolName,
      status: e.data.success === false ? 'failed' : 'completed',
      ...(toolRun ? { durationMs: Date.now() - toolRun.startedAt } : {}),
      details: {
        toolCallId,
        ...(typeof e.data.error === 'string' ? { error: e.data.error } : {}),
      },
    });
    if (toolCallId) trajectoryToolStarts.delete(toolCallId);
  });
  // These events are UI status signals, not model chain-of-thought. Keep them
  // operational so the browser never receives hidden reasoning text.
  const offPermission = session.on('permission.requested', (e) => {
    input.onStatus?.('这一步需要你的确认，请在提示出现后继续操作。');
    input.onTrajectory?.({
      type: 'permission',
      name: '需要确认',
      status: 'waiting',
      details: {},
    });
  });
  const offCompaction = session.on('session.compaction_start', () => {
    input.onStatus?.('助手正在整理前面的对话内容，请稍候…');
    input.onTrajectory?.({ type: 'compaction', name: '整理上下文', status: 'started' });
  });
  const offCompactionComplete = session.on('session.compaction_complete', (e) => {
    input.onTrajectory?.({
      type: 'compaction',
      name: '整理上下文',
      status: e.data.success === false ? 'failed' : 'completed',
      details: {
        ...(typeof e.data.preCompactionTokens === 'number' ? { preCompactionTokens: e.data.preCompactionTokens } : {}),
      },
    });
  });
  const offUsage = session.on('assistant.usage', (e) => {
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
      name: '模型调用',
      status: 'completed',
      details: {},
    };
    if (typeof e.data.model === 'string') event.model = e.data.model;
    if (typeof e.data.inputTokens === 'number') event.inputTokens = e.data.inputTokens;
    if (typeof e.data.outputTokens === 'number') event.outputTokens = e.data.outputTokens;
    if (typeof e.data.cost === 'number') event.premiumRequestCost = e.data.cost;
    if (typeof e.data.duration === 'number') event.durationMs = e.data.duration;
    if (typeof e.data.apiEndpoint === 'string') event.details.apiEndpoint = e.data.apiEndpoint;
    input.onTrajectory?.(event);
  });
  const offUsageInfo = session.on('session.usage_info', (e) => {
    input.onTrajectory?.({
      type: 'status',
      name: '上下文占用',
      status: 'info',
      details: {
        currentTokens: e.data.currentTokens,
        tokenLimit: e.data.tokenLimit,
        messagesLength: e.data.messagesLength,
      },
    });
  });
  try {
    if (input.shouldAbort?.()) {
      await session.abort();
      throw new Error('Turn aborted.');
    }
    const final = await session.sendAndWait({ prompt: input.prompt }, config.turnTimeoutMs);
    const usageAfter = await getSessionUsageMetrics(session);
    const turnUsage = diffUsageMetrics(usageAfter, usageBefore);
    input.onTrajectory?.({
      type: 'turn_end',
      name: 'Agent 本轮结束',
      status: 'completed',
      details: {
        ...(turnUsage ? { turnUsage: redactTrajectoryValue(turnUsage) } : {}),
      },
    });
    return final?.data.content || content;
  } catch (e) {
    input.onTrajectory?.({
      type: 'error',
      name: 'Agent 执行失败',
      status: 'failed',
      details: { error: e instanceof Error ? e.message : String(e) },
    });
    if (e instanceof Error && TURN_TIMEOUT.test(e.message)) {
      try {
        await session.abort();
      } catch {
        /* ignore */
      }
    }
    throw e;
  } finally {
    if (input.turnId) activeSessions.delete(input.turnId);
    offMessageDelta();
    offIntent();
    offReasoning();
    offToolStart();
    offToolComplete();
    offPermission();
    offCompaction();
    offCompactionComplete();
    offUsage();
    offUsageInfo();
    try {
      await session.disconnect();
    } catch {
      /* ignore */
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
    } catch {
      /* preserve the original resume error */
    }
    throw e;
  }
}
