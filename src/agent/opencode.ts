/**
 * OpenCode 本机运行时适配器。
 *
 * 这里不直接依赖 OpenCode SDK，而是调用 `opencode serve` 提供的 HTTP API。
 * 这样项目不需要额外安装一个第二套 SDK，OpenCode 自己负责 provider / model / tools / MCP / 权限。
 *
 * 模型配置格式：
 *   opencode:<providerID>/<modelID>
 *
 * 例如：
 *   opencode:ollama/qwen3-coder
 *   opencode:openai/gpt-5
 *
 * OpenCode 只负责本轮 Agent 执行；Investigation 的 Mission、Evidence、Conversation、
 * Stage Gate 等业务状态仍然由本项目自己管理。
 */
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import {
  GRAPHIFY_MCP_NAME,
  GRAPHIFY_SELECTION_INSTRUCTION,
  buildGraphifyMcpServer,
  ensureGraphifyGraph,
  isGraphifyTool,
} from '../adapters/graphify.js';
import { applyAgentWorkflowTransition, buildJourneyAgentInstruction } from '../workflow/journey-editor.js';
import type { WorkflowId } from '../investigation/schemas.js';
import * as z from 'zod';

export interface OpenCodeModelOption {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
}

interface OpenCodeProvider {
  id: string;
  name?: string;
  models?: Record<string, {
    id?: string;
    name?: string;
    status?: string;
    capabilities?: Record<string, unknown>;
  }>;
}

interface OpenCodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

interface OpenCodePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
  };
}

const STRUCTURAL_PROMPT_PATTERN =
  /(调用链|调用关系|依赖关系|依赖图|上下游|数据流|血缘|路径|结构枢纽|结构节点|子系统|组件关系|模块关系|连接关系|从哪里来|被谁调用|call\s*graph|dependenc(?:y|ies)\s*(graph|chain)?|upstream|downstream|lineage|data\s*flow|shortest\s*path|subsystem|hub|module\s+relationship|component\s+relationship)/iu;

const GRAPHIFY_MCP_TOOL_KEYS = [
  'query_graph',
  'get_node',
  'get_neighbors',
  'get_community',
  'god_nodes',
  'graph_stats',
  'shortest_path',
].map((tool) => GRAPHIFY_MCP_NAME + '_' + tool);

export function requiresGraphifyFirst(prompt: string): boolean {
  return STRUCTURAL_PROMPT_PATTERN.test(prompt);
}

export function graphifyPreflightTools(): Record<string, boolean> {
  return {
    read: false,
    grep: false,
    glob: false,
    bash: false,
    edit: false,
    write: false,
    apply_patch: false,
    task: false,
    webfetch: false,
    websearch: false,
    skill: false,
    todowrite: false,
    todoread: false,
    ...Object.fromEntries(GRAPHIFY_MCP_TOOL_KEYS.map((tool) => [tool, true])),
  };
}

const activeOpenCodeTurns = new Map<string, () => Promise<void>>();

/** 返回并停止当前 OpenCode turn；HTTP Stop API 会复用这个运行态。 */
export async function abortOpenCodeTurn(turnId: string): Promise<boolean> {
  const abort = activeOpenCodeTurns.get(turnId);
  if (!abort) return false;
  try {
    await abort();
    return true;
  } catch {
    return false;
  }
}

export interface OpenCodeAskInput {
  model: string;
  prompt: string;
  systemPrompt: string;
  workingDirectory: string;
  turnId?: string;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onStatus?: (status: string) => void;
  onTrajectory?: (event: {
    type: 'turn_start' | 'assistant_turn_start' | 'assistant_turn_end' | 'tool_call' | 'tool_result' | 'status' | 'error';
    name: string;
    status?: 'started' | 'completed' | 'failed' | 'info';
    model?: string;
    details?: Record<string, unknown>;
  }) => void;
  shouldAbort?: () => boolean;
  autoContinuationTurns?: number;
  missionPrompt?: string;
  refreshMissionPrompt?: () => string | Promise<string>;
  shouldContinueMission?: () => boolean | Promise<boolean>;
  onStageResult?: (result: { content: string; execution: number }) => void | Promise<void | { passed?: boolean; error?: string }>;
  responseSchema?: z.ZodTypeAny;
  onBeforeWorkflowTransition?: (result: { content: string; execution: number }) => Promise<void>;
  workflowSkill?: WorkflowId;
  purpose?: 'investigation' | 'journey-map' | 'review';
  investigationName?: string;
}

export function isOpenCodeModel(model: string): boolean {
  return model.trim().startsWith('opencode:');
}

/** 把 UI 里的 OpenCode 模型引用拆成 providerID / modelID。 */
export function parseOpenCodeModel(model: string): { providerId: string; modelId: string } {
  const value = model.trim();
  const match = /^opencode:([^/]+)\/(.+)$/.exec(value);
  if (!match) {
    throw new Error('OpenCode 模型格式不正确，应为 opencode:<provider>/<model>。');
  }
  return {
    providerId: match[1],
    modelId: match[2],
  };
}

function authHeaders(): Record<string, string> {
  if (!config.openCodePassword) return {};
  const username = config.openCodeUsername || 'opencode';
  return {
    Authorization: 'Basic ' + Buffer.from(username + ':' + config.openCodePassword).toString('base64'),
  };
}

function baseUrl(): string {
  return config.openCodeBaseUrl.replace(/\/+$/, '');
}

function withDirectory(pathname: string, workingDirectory?: string): string {
  if (!workingDirectory) return pathname;
  const separator = pathname.includes('?') ? '&' : '?';
  return pathname + separator + 'directory=' + encodeURIComponent(workingDirectory);
}

async function openCodeFetch(
  pathname: string,
  init: RequestInit = {},
  workingDirectory?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  return fetch(baseUrl() + withDirectory(pathname, workingDirectory), {
    ...init,
    headers,
  });
}

/** 把平台内置 Graphify 动态注册到当前 OpenCode workspace，不写入被调查仓库的配置文件。 */
export async function registerOpenCodeGraphifyMcp(
  workingDirectory: string,
  commandOverride?: string,
): Promise<void> {
  const graphify = buildGraphifyMcpServer(workingDirectory, commandOverride);
  if (!graphify) return;

  // OpenCode Server 按 workspace 维护 MCP 状态；同一 Investigation 的后续 turn 不应重复注册同名 server。
  const existingResponse = await openCodeFetch('/mcp', { method: 'GET' }, workingDirectory);
  if (existingResponse.ok) {
    try {
      const existing = await existingResponse.json() as Record<string, { status?: unknown }>;
      const current = existing[graphify.name];
      const currentStatus = typeof current?.status === 'string'
        ? current.status
        : current?.status && typeof current.status === 'object' && 'status' in current.status
          ? String((current.status as { status?: unknown }).status ?? '')
          : '';
      if (['connected', 'connecting', 'pending'].includes(currentStatus.toLowerCase())) {
        return;
      }
    } catch {
      // 无法读取状态时继续尝试注册，让真正的 MCP API 给出明确结果。
    }
  }

  const response = await openCodeFetch(
    '/mcp',
    {
      method: 'POST',
      body: JSON.stringify({
        name: graphify.name,
        config: {
          type: 'local',
          command: [graphify.server.command, ...graphify.server.args],
          cwd: workingDirectory,
          enabled: true,
          timeout: 5_000,
        },
      }),
    },
    workingDirectory,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      '无法把 Graphify 加入 OpenCode：HTTP '
      + response.status
      + (detail ? ' · ' + detail.slice(0, 500) : ''),
    );
  }
}

/** 查询 OpenCode 当前已经配置并连通的 provider/model。allowlist 可显式传入，方便测试；默认读全局配置。 */
export async function listOpenCodeModels(allowlist: readonly string[] = config.openCodeModelAllowlist): Promise<OpenCodeModelOption[]> {
  if (!config.openCodeEnabled) return [];

  const response = await openCodeFetch('/provider');
  if (!response.ok) {
    throw new Error('OpenCode 服务不可用：HTTP ' + response.status);
  }

  const payload = await response.json() as { all?: OpenCodeProvider[]; connected?: string[] };
  const connected = new Set(payload.connected ?? []);
  const result: OpenCodeModelOption[] = [];

  for (const provider of payload.all ?? []) {
    // 只展示 OpenCode 当前已经连接的 provider，避免把未登录/未配置的模型
    // 塞进工作台后才在真正执行时失败。
    if (connected.size > 0 && !connected.has(provider.id)) continue;
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      const modelId = model.id?.trim() || modelKey;
      if (!modelId) continue;
      const id = `opencode:${provider.id}/${modelId}`;
      const name = `OpenCode · ${provider.name?.trim() || provider.id} · ${model.name?.trim() || modelId}`;
      // 白名单为空 = 不过滤；否则 id 或显示名命中任一条才列出。
      if (allowlist.length > 0) {
        const haystack = (id + ' ' + name).toLowerCase();
        if (!allowlist.some((entry) => haystack.includes(entry))) continue;
      }
      result.push({ id, name, providerId: provider.id, modelId });
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSseBlock(block: string): OpenCodeEvent | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return undefined;

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;

    // OpenCode 某些版本会把事件包在 payload 里；两种格式都兼容。
    const envelope = parsed as Record<string, unknown>;
    const payload = envelope.payload && typeof envelope.payload === 'object'
      ? envelope.payload as Record<string, unknown>
      : envelope;

    const event: OpenCodeEvent = {};
    if (typeof payload.type === 'string') event.type = payload.type;
    if (payload.properties && typeof payload.properties === 'object') {
      event.properties = payload.properties as Record<string, unknown>;
    }
    return event;
  } catch {
    return undefined;
  }
}

async function consumeOpenCodeEvents(
  response: Response,
  input: OpenCodeAskInput,
  sessionId: string,
  /** 后台 reader 只记录、不抛错：抛错会变成 unhandled rejection 直接崩掉整个服务进程。 */
  readerState: { sessionError?: string; graphifyUsed?: boolean },
): Promise<void> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const partTexts = new Map<string, string>();

  try {
    for (;;) {
      if (input.shouldAbort?.()) {
        await abortOpenCodeSession(sessionId);
        throw new Error('Turn aborted.');
      }

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (!event?.type || !event.properties) continue;

        const properties = event.properties;
        const eventSessionId = typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
        if (eventSessionId && eventSessionId !== sessionId) continue;

        if (event.type === 'message.part.delta') {
          const field = typeof properties.field === 'string' ? properties.field : '';
          const delta = typeof properties.delta === 'string' ? properties.delta : '';
          if (!delta) continue;

          if (field === 'text') {
            const partId = typeof properties.partID === 'string' ? properties.partID : 'text';
            const partType = partId.startsWith('reasoning') ? 'reasoning' : 'text';
            if (partType === 'reasoning') input.onReasoningDelta?.(delta);
            else input.onDelta?.(delta);
          }
          continue;
        }

        if (event.type === 'message.part.updated') {
          const part = properties.part as OpenCodePart | undefined;
          if (!part || part.type === 'text' && !part.id) continue;

          const partId = part.id ?? part.type ?? 'part';
          const currentText = typeof part.text === 'string' ? part.text : '';
          const previousText = partTexts.get(partId) ?? '';
          partTexts.set(partId, currentText);

          // 优先依赖 delta；某些 OpenCode 版本没有 delta，只发送完整的 part.updated。
          if (currentText.length > previousText.length && currentText.startsWith(previousText)) {
            const delta = currentText.slice(previousText.length);
            if (part.type === 'reasoning') input.onReasoningDelta?.(delta);
            else if (part.type === 'text') input.onDelta?.(delta);
          }

          if (part.type === 'tool') {
            const toolName = part.tool?.trim() || '工具';
            const status = part.state?.status;
            const graphifyToolCall = isGraphifyTool({ toolName });
            if (graphifyToolCall) readerState.graphifyUsed = true;
            if (status === 'running') {
              input.onStatus?.(
                graphifyToolCall
                  ? '助手正在用 Graphify 查看代码结构，请稍候…'
                  : 'OpenCode 正在使用工具 ' + toolName + '，请稍候…',
              );
              input.onTrajectory?.({
                type: 'tool_call',
                name: graphifyToolCall ? 'Graphify 结构分析：' + toolName : 'OpenCode 工具：' + toolName,
                status: 'started',
                model: input.model,
                details: {
                  sessionId,
                  tool: toolName,
                  ...(graphifyToolCall ? {
                    mcpServerName: GRAPHIFY_MCP_NAME,
                    mcpToolName: toolName,
                  } : {}),
                },
              });
            } else if (status === 'completed' || status === 'error') {
              input.onStatus?.(
                graphifyToolCall
                  ? 'Graphify 已完成结构查询，正在整理结果…'
                  : 'OpenCode 已完成工具调用，正在整理结果…',
              );
              input.onTrajectory?.({
                type: 'tool_result',
                name: graphifyToolCall ? 'Graphify 结构分析：' + toolName : 'OpenCode 工具：' + toolName,
                status: status === 'completed' ? 'completed' : 'failed',
                model: input.model,
                details: {
                  sessionId,
                  tool: toolName,
                  status,
                  ...(graphifyToolCall ? {
                    mcpServerName: GRAPHIFY_MCP_NAME,
                    mcpToolName: toolName,
                  } : {}),
                },
              });
            }
          }
          continue;
        }

        if (event.type === 'session.status') {
          const status = properties.status;
          const statusType = status && typeof status === 'object'
            ? (status as Record<string, unknown>).type
            : typeof status === 'string' ? status : undefined;

          if (statusType === 'busy') input.onStatus?.('OpenCode 正在执行，请稍候…');
          else if (statusType === 'retry') input.onStatus?.('OpenCode 正在重试当前模型，请稍候…');
          else if (statusType === 'idle') input.onStatus?.('OpenCode 已完成本轮执行。');
          continue;
        }

        if (event.type === 'session.error') {
          // 服务端有时只给 name=APIError，真正的原因藏在 error.data 里
          //（例如 data.message + statusCode），逐层挖出来，否则 UI 永远只显示四个字。
          const error = properties.error;
          const record = error && typeof error === 'object'
            ? error as Record<string, unknown>
            : undefined;
          const data = record?.data && typeof record.data === 'object'
            ? record.data as Record<string, unknown>
            : undefined;
          const detail = data && typeof data.message === 'string' ? data.message : undefined;
          const statusCode = typeof data?.statusCode === 'number' ? `（HTTP ${data.statusCode}）` : '';
          const message = detail
            ? detail + statusCode
            : record && typeof record.message === 'string'
              ? record.message
              : 'OpenCode 执行失败' + (typeof record?.name === 'string' ? '：' + record.name : '');
          // 只记录、不 throw：本轮成败以 message 接口的返回为准；
          // 这里抛错只会变成后台任务的 unhandled rejection 崩掉服务进程。
          readerState.sessionError = message;
          input.onStatus?.('OpenCode 本轮遇到问题：' + message);
          input.onTrajectory?.({
            type: 'error',
            name: 'OpenCode 会话错误',
            status: 'failed',
            model: input.model,
            details: { sessionId, error: message },
          });
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function abortOpenCodeSession(sessionId: string): Promise<void> {
  try {
    await openCodeFetch('/session/' + encodeURIComponent(sessionId) + '/abort', { method: 'POST' });
  } catch {
    // Abort 失败不能覆盖原始的停止错误。
  }
}

function extractTextParts(value: unknown): { answer: string; reasoning: string; usage?: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return { answer: '', reasoning: '' };
  const object = value as { parts?: unknown };
  if (!Array.isArray(object.parts)) return { answer: '', reasoning: '' };

  const answerParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const raw of object.parts) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as OpenCodePart;
    if (part.type === 'text' && typeof part.text === 'string') answerParts.push(part.text);
    if (part.type === 'reasoning' && typeof part.text === 'string') reasoningParts.push(part.text);
  }
  const info = (value as { info?: unknown }).info;
  const infoRecord = info && typeof info === 'object'
    ? info as Record<string, unknown>
    : undefined;
  const structuredOutput = infoRecord?.structured_output;
  if (structuredOutput !== undefined) {
    return {
      answer: JSON.stringify(structuredOutput),
      reasoning: '',
      ...(infoRecord?.tokens && typeof infoRecord.tokens === 'object'
        ? { usage: {
            ...(infoRecord.tokens as Record<string, unknown>),
            ...(typeof infoRecord.cost === 'number' ? { cost: infoRecord.cost } : {}),
          } }
        : {}),
    };
  }
  const tokens = infoRecord?.tokens && typeof infoRecord.tokens === 'object'
    ? infoRecord.tokens as Record<string, unknown>
    : undefined;
  const usage = tokens
    ? {
        ...tokens,
        ...(typeof infoRecord?.cost === 'number' ? { cost: infoRecord.cost } : {}),
      }
    : undefined;
  return {
    answer: answerParts.join('\n').trim(),
    reasoning: reasoningParts.join('\n').trim(),
    ...(usage ? { usage } : {}),
  };
}

const OPENCODE_CLI_AGENT = 'agentic-data-architect-runtime';

export function buildOpenCodeCliPrompt(
  input: Pick<OpenCodeAskInput, 'missionPrompt' | 'systemPrompt'>,
  prompt: string,
  workflowInstruction: string,
  preflight: boolean,
  graphifyEnabled: boolean,
  responseSchema?: z.ZodTypeAny,
): string {
  const sections = [
    ...(preflight
      ? [
          '这是结构调查的前置步骤。',
          '先使用 Graphify MCP 完成结构导航；至少执行一次 Graphify 查询。',
          '这一轮不要先回答用户的问题；先完成结构导航并返回关键节点/关系，供下一轮继续核实。',
        ]
      : []),
    input.missionPrompt,
    input.systemPrompt,
    graphifyEnabled ? GRAPHIFY_SELECTION_INSTRUCTION : '',
    workflowInstruction,
    ...(responseSchema
      ? [
          '输出必须是严格合法的 JSON，且必须符合下面的 JSON Schema；不要输出 Markdown 代码围栏或额外说明。',
          JSON.stringify(z.toJSONSchema(responseSchema)),
        ]
      : []),
    '当前用户任务：',
    prompt,
  ];

  return sections.filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
}

function buildOpenCodeCliConfig(
  preflight: boolean,
  graphifyServer?: Awaited<ReturnType<typeof buildGraphifyMcpServer>>,
): string {
  let existing: Record<string, unknown> = {};
  const raw = process.env.OPENCODE_CONFIG_CONTENT?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error('OPENCODE_CONFIG_CONTENT 不是合法 JSON，无法启动 OpenCode CLI。');
    }
  }

  const existingAgents = existing.agent && typeof existing.agent === 'object' && !Array.isArray(existing.agent)
    ? existing.agent as Record<string, unknown>
    : {};
  const existingAgent = existingAgents[OPENCODE_CLI_AGENT] && typeof existingAgents[OPENCODE_CLI_AGENT] === 'object'
    && !Array.isArray(existingAgents[OPENCODE_CLI_AGENT])
    ? existingAgents[OPENCODE_CLI_AGENT] as Record<string, unknown>
    : {};

  const agents = {
    ...existingAgents,
    [OPENCODE_CLI_AGENT]: {
      ...existingAgent,
      mode: 'primary',
      ...(preflight ? { tools: graphifyPreflightTools() } : {}),
    },
  };

  const existingMcp = existing.mcp && typeof existing.mcp === 'object' && !Array.isArray(existing.mcp)
    ? existing.mcp as Record<string, unknown>
    : {};
  const mcp = graphifyServer
    ? {
        ...existingMcp,
        [graphifyServer.name]: {
          ...graphifyServer.server,
          enabled: true,
        },
      }
    : existing.mcp;

  return JSON.stringify({
    ...existing,
    agent: agents,
    ...(mcp !== undefined ? { mcp } : {}),
  });
}

interface OpenCodeCliEvent {
  type?: string;
  sessionID?: string;
  part?: OpenCodePart & Record<string, unknown>;
  error?: unknown;
  [key: string]: unknown;
}

function extractOpenCodeCliError(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : undefined;
  if (typeof data?.message === 'string') {
    const statusCode = typeof data.statusCode === 'number' ? '（HTTP ' + data.statusCode + '）' : '';
    return data.message + statusCode;
  }
  if (typeof record.message === 'string') return record.message;
  if (typeof record.name === 'string') return record.name;
  return JSON.stringify(value);
}

interface OpenCodeCliExecutionResult {
  answer: string;
  sessionId: string;
  graphifyUsed: boolean;
  usage?: Record<string, unknown>;
  stderr: string;
}

async function runOpenCodeCli(
  input: OpenCodeAskInput,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<OpenCodeCliExecutionResult> {
  const child = spawn('opencode', args, {
    cwd: input.workingDirectory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let sessionId = '';
  const answerParts: string[] = [];
  let graphifyUsed = false;
  let usage: Record<string, unknown> | undefined;
  let sessionError: string | undefined;
  let stderr = '';
  let stdoutFallback = '';
  let buffer = '';

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: OpenCodeCliEvent;
    try {
      event = JSON.parse(trimmed) as OpenCodeCliEvent;
    } catch {
      stdoutFallback += (stdoutFallback ? '\n' : '') + trimmed;
      return;
    }

    if (typeof event.sessionID === 'string' && event.sessionID) {
      sessionId = event.sessionID;
    }

    if (event.type === 'text') {
      const part = event.part;
      const text = part && typeof part.text === 'string' ? part.text : '';
      if (text.trim()) {
        answerParts.push(text);
        input.onDelta?.(text);
      }
      return;
    }

    if (event.type === 'reasoning') {
      const part = event.part;
      const text = part && typeof part.text === 'string' ? part.text : '';
      if (text.trim()) input.onReasoningDelta?.(text);
      return;
    }

    if (event.type === 'tool_use') {
      const part = event.part;
      if (!part || part.type !== 'tool') return;

      const toolName = typeof part.tool === 'string' && part.tool.trim() ? part.tool.trim() : '工具';
      const status = part.state?.status;
      const graphifyToolCall = isGraphifyTool({ toolName });
      if (graphifyToolCall) graphifyUsed = true;

      input.onStatus?.(
        graphifyToolCall
          ? (status === 'error' ? 'Graphify 结构查询失败，正在整理错误信息…' : 'Graphify 已完成结构查询，正在整理结果…')
          : (status === 'error' ? 'OpenCode 工具调用失败，正在整理错误信息…' : 'OpenCode 已完成工具调用，正在整理结果…'),
      );
      input.onTrajectory?.({
        type: 'tool_result',
        name: graphifyToolCall ? 'Graphify 结构分析：' + toolName : 'OpenCode 工具：' + toolName,
        status: status === 'error' ? 'failed' : 'completed',
        model: input.model,
        details: {
          sessionId,
          tool: toolName,
          ...(graphifyToolCall ? {
            mcpServerName: GRAPHIFY_MCP_NAME,
            mcpToolName: toolName,
          } : {}),
        },
      });
      return;
    }

    if (event.type === 'step_start') {
      input.onStatus?.('OpenCode 正在执行，请稍候…');
      input.onTrajectory?.({
        type: 'status',
        name: 'OpenCode 执行步骤开始',
        status: 'started',
        model: input.model,
        details: { sessionId },
      });
      return;
    }

    if (event.type === 'step_finish') {
      const part = event.part;
      const tokens = part?.tokens;
      const cost = typeof part?.cost === 'number' ? part.cost : undefined;
      if (tokens && typeof tokens === 'object') {
        usage = {
          ...(tokens as Record<string, unknown>),
          ...(cost !== undefined ? { cost } : {}),
        };
      } else if (cost !== undefined) {
        usage = { ...(usage ?? {}), cost };
      }
      input.onTrajectory?.({
        type: 'status',
        name: 'OpenCode 模型调用完成',
        status: 'info',
        model: input.model,
        details: {
          sessionId,
          ...(usage ? { usage } : {}),
        },
      });
      return;
    }

    if (event.type === 'error') {
      sessionError = extractOpenCodeCliError(event.error) ?? 'OpenCode 执行失败';
      input.onStatus?.('OpenCode 本轮遇到问题：' + sessionError);
      input.onTrajectory?.({
        type: 'error',
        name: 'OpenCode 会话错误',
        status: 'failed',
        model: input.model,
        details: { sessionId, error: sessionError },
      });
    }
  };

  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectExit!: (reason: unknown) => void;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  child.once('error', rejectExit);
  child.once('close', (code, signal) => resolveExit({ code, signal }));

  const stderrTask = (async () => {
    if (!child.stderr) return;
    for await (const chunk of child.stderr) {
      if (stderr.length >= 16_000) continue;
      stderr += chunk.toString('utf8').slice(0, 16_000 - stderr.length);
    }
  })();

  const stdoutTask = (async () => {
    if (!child.stdout) return;
    for await (const chunk of child.stdout) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);
  })();

  const abort = async () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  if (input.turnId) activeOpenCodeTurns.set(input.turnId, abort);

  try {
    input.onTrajectory?.({
      type: 'turn_start',
      name: 'OpenCode CLI Agent 开始',
      status: 'started',
      model: input.model,
      details: {
        providerId: parseOpenCodeModel(input.model).providerId,
        modelId: parseOpenCodeModel(input.model).modelId,
        workingDirectory: input.workingDirectory,
      },
    });

    await Promise.all([stdoutTask, stderrTask, exitPromise]);
  } finally {
    if (input.turnId) activeOpenCodeTurns.delete(input.turnId);
  }

  const exit = await exitPromise;
  const answer = answerParts.join('\n').trim();

  if (sessionError) throw new Error(sessionError);
  if (exit.code !== 0) {
    const detail = stderr.trim() || stdoutFallback.trim();
    throw new Error(
      'OpenCode CLI 执行失败'
      + (exit.code !== null ? '：退出码 ' + exit.code : exit.signal ? '：被 ' + exit.signal + ' 终止' : '')
      + (detail ? '\n' + detail.slice(0, 1200) : ''),
    );
  }
  if (!answer) {
    const fallback = stdoutFallback.trim();
    if (fallback) {
      return { answer: fallback, sessionId, graphifyUsed, ...(usage ? { usage } : {}), stderr };
    }
    throw new Error('OpenCode CLI 没有返回文本答案。' + (stderr.trim() ? ' ' + stderr.trim().slice(0, 1000) : ''));
  }

  return {
    answer,
    sessionId,
    graphifyUsed,
    ...(usage ? { usage } : {}),
    stderr,
  };
}

/**
 * 执行一轮 OpenCode。
 *
 * OpenCode model 统一通过官方 opencode run headless CLI 执行，不再通过
 * opencode serve 的 /session/.../message HTTP API 直接驱动模型。
 *
 * 每个用户 turn 创建一个 OpenCode session；turn 内的自动续跑复用同一个 Session。
 * 对话上下文由本项目 prompt 和 Mission Contract 管理，不依赖 OpenCode 的长期工作台状态，
 * 避免 Copilot Session 与 OpenCode Session 两套持久化状态互相打架。
 */
export async function askOpenCode(input: OpenCodeAskInput): Promise<string> {
  if (!config.openCodeEnabled) {
    throw new Error('OpenCode 运行时没有启用，请检查 OPENCODE_ENABLED。');
  }

  const { providerId, modelId } = parseOpenCodeModel(input.model);
  const graphifyEnabled = input.purpose !== 'journey-map'
    && input.purpose !== 'review'
    && config.graphifyEnabled;
  let graphifyServer: Awaited<ReturnType<typeof buildGraphifyMcpServer>> | undefined;
  if (graphifyEnabled) {
    await ensureGraphifyGraph(input.workingDirectory, false);
    graphifyServer = buildGraphifyMcpServer(input.workingDirectory);
  }

  let sessionId = '';
  const requestedAutomaticContinuations = Math.min(
    6,
    Math.max(0, Math.round(input.autoContinuationTurns ?? 0)),
  );
  const maxAutomaticContinuations = graphifyEnabled && requiresGraphifyFirst(input.prompt)
    ? Math.min(6, requestedAutomaticContinuations + 1)
    : requestedAutomaticContinuations;
  let currentPrompt = input.prompt;
  let currentWorkflowInstruction = input.purpose === 'review'
    ? ''
    : input.workflowSkill && input.investigationName
      ? await buildJourneyAgentInstruction(input.investigationName, input.workflowSkill).catch(() => '')
      : '';
  let finalAnswer = '';

  for (let execution = 0; execution <= maxAutomaticContinuations; execution += 1) {
    if (input.shouldAbort?.()) throw new Error('Turn aborted.');

    if (execution > 0) {
      input.onStatus?.('OpenCode 已完成前一阶段，正在继续调查（第 ' + (execution + 1) + ' 阶段）…');
    }

    const preflight = execution === 0 && graphifyEnabled && requiresGraphifyFirst(input.prompt);
    const cliPrompt = buildOpenCodeCliPrompt(
      input,
      currentPrompt,
      currentWorkflowInstruction,
      preflight,
      graphifyEnabled,
      input.responseSchema,
    );

    input.onStatus?.(preflight ? '正在先用 Graphify 梳理代码结构…' : 'OpenCode 正在执行，请稍候…');
    const cliConfig = buildOpenCodeCliConfig(preflight, graphifyServer);
    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: cliConfig,
    };

    const cliArgs = [
      'run',
      '--format',
      'json',
      '--model',
      providerId + '/' + modelId,
      '--dir',
      input.workingDirectory,
      '--agent',
      OPENCODE_CLI_AGENT,
      ...(input.onReasoningDelta ? ['--thinking'] : []),
      ...(sessionId ? ['--session', sessionId] : []),
      cliPrompt,
    ];

    const result = await runOpenCodeCli(input, cliArgs, env);
    sessionId = result.sessionId || sessionId;

    if (result.usage) {
      const inputTokens = typeof result.usage.input === 'number' ? result.usage.input : undefined;
      const outputTokens = typeof result.usage.output === 'number' ? result.usage.output : undefined;
      const reasoningTokens = typeof result.usage.reasoning === 'number' ? result.usage.reasoning : undefined;
      const cost = typeof result.usage.cost === 'number' ? result.usage.cost : undefined;
      input.onTrajectory?.({
        type: 'status',
        name: 'OpenCode 模型调用完成',
        status: 'info',
        model: input.model,
        details: {
          execution,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          ...(cost !== undefined ? { cost } : {}),
        },
      });
    }

    if (preflight) {
      if (!result.graphifyUsed) {
        throw new Error('结构调查前置检查失败：OpenCode 没有先使用 Graphify。');
      }
      input.onTrajectory?.({
        type: 'status',
        name: 'Graphify 结构分析前置检查完成',
        status: 'completed',
        model: input.model,
        details: { execution, sessionId },
      });
      currentPrompt = input.prompt;
      continue;
    }

    finalAnswer = result.answer;

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
      input.onStatus?.('OpenCode 本阶段没有通过 Workflow Gate，继续补齐结果。');
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
        '只做直接服务于 Mission 剩余交付物的工作；能通过现有工具、代码、SQL、配置、文档或 Skill 完成的就直接执行，不要只给建议。',
        ...(workflowTransition.error ? ['', '上一阶段 Gate 没通过：', workflowTransition.error] : []),
      ].filter(Boolean).join('\n');
    } else {
      currentPrompt = [
        '继续自主推进当前 Investigation。',
        input.missionPrompt ?? '',
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
    name: 'OpenCode CLI Agent 完成',
    status: 'completed',
    model: input.model,
    details: {
      sessionId,
      providerId,
      modelId,
      automaticContinuations: maxAutomaticContinuations,
    },
  });
  return finalAnswer;
}
