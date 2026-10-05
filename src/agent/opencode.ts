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
import { config } from '../config.js';

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
}

export function isOpenCodeModel(model: string): boolean {
  return model.trim().startsWith('opencode:');
}

/** 把 UI 里的 OpenCode 模型引用拆成 providerID / modelID。 */
export function parseOpenCodeModel(model: string): { providerId: string; modelId: string } {
  const value = model.trim();
  const match = /^opencode:([^/]+)\\/(.+)$/.exec(value);
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

function directoryHeaders(workingDirectory?: string): Record<string, string> {
  return workingDirectory ? { 'x-opencode-directory': workingDirectory } : {};
}

function baseUrl(): string {
  return config.openCodeBaseUrl.replace(/\\/+$/, '');
}

async function openCodeFetch(
  pathname: string,
  init: RequestInit = {},
  workingDirectory?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
  for (const [key, value] of Object.entries(directoryHeaders(workingDirectory))) headers.set(key, value);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  return fetch(baseUrl() + pathname, {
    ...init,
    headers,
  });
}

/** 查询 OpenCode 当前已经配置并连通的 provider/model。 */
export async function listOpenCodeModels(): Promise<OpenCodeModelOption[]> {
  if (!config.openCodeEnabled) return [];

  const response = await openCodeFetch('/provider');
  if (!response.ok) {
    throw new Error('OpenCode 服务不可用：HTTP ' + response.status);
  }

  const payload = await response.json() as { all?: OpenCodeProvider[] };
  const result: OpenCodeModelOption[] = [];

  for (const provider of payload.all ?? []) {
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      const modelId = model.id?.trim() || modelKey;
      if (!modelId) continue;
      result.push({
        id: `opencode:${provider.id}/${modelId}`,
        name: `OpenCode · ${provider.name?.trim() || provider.id} · ${model.name?.trim() || modelId}`,
        providerId: provider.id,
        modelId,
      });
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSseBlock(block: string): OpenCodeEvent | undefined {
  const data = block
    .split(/\\r?\\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\\n');
  if (!data) return undefined;

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;

    // OpenCode 某些版本会把事件包在 payload 里；两种格式都兼容。
    const envelope = parsed as Record<string, unknown>;
    const payload = envelope.payload && typeof envelope.payload === 'object'
      ? envelope.payload as Record<string, unknown>
      : envelope;

    return {
      type: typeof payload.type === 'string' ? payload.type : undefined,
      properties: payload.properties && typeof payload.properties === 'object'
        ? payload.properties as Record<string, unknown>
        : undefined,
    };
  } catch {
    return undefined;
  }
}

async function consumeOpenCodeEvents(
  response: Response,
  input: OpenCodeAskInput,
  sessionId: string,
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
      const blocks = buffer.split(/\\r?\\n\\r?\\n/);
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
            if (status === 'running') {
              input.onStatus?.('OpenCode 正在使用工具 ' + toolName + '，请稍候…');
              input.onTrajectory?.({
                type: 'tool_call',
                name: 'OpenCode 工具：' + toolName,
                status: 'started',
                model: input.model,
                details: {
                  sessionId,
                  tool: toolName,
                },
              });
            } else if (status === 'completed' || status === 'error') {
              input.onStatus?.('OpenCode 已完成工具调用，正在整理结果…');
              input.onTrajectory?.({
                type: 'tool_result',
                name: 'OpenCode 工具：' + toolName,
                status: status === 'completed' ? 'completed' : 'failed',
                model: input.model,
                details: {
                  sessionId,
                  tool: toolName,
                  status,
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
          const error = properties.error;
          const message = error && typeof error === 'object'
            ? String((error as Record<string, unknown>).message ?? (error as Record<string, unknown>).name ?? 'OpenCode 执行失败')
            : String(error ?? 'OpenCode 执行失败');
          throw new Error(message);
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

function extractTextParts(value: unknown): { answer: string; reasoning: string } {
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
  return {
    answer: answerParts.join('\\n').trim(),
    reasoning: reasoningParts.join('\\n').trim(),
  };
}

/**
 * 执行一轮 OpenCode。
 *
 * 每一轮独立创建一个 OpenCode session；对话上下文由本项目 prompt 已经整理好，
 * 因此不强依赖 OpenCode 自己的长期 session。这样不会出现 Copilot Session 和 OpenCode Session
 * 两套持久化状态互相打架的问题。
 */
export async function askOpenCode(input: OpenCodeAskInput): Promise<string> {
  if (!config.openCodeEnabled) {
    throw new Error('OpenCode 运行时没有启用，请检查 OPENCODE_ENABLED。');
  }

  const { providerId, modelId } = parseOpenCodeModel(input.model);
  const directory = encodeURIComponent(input.workingDirectory);
  const transportController = new AbortController();
  let sessionId = '';

  const eventResponse = await openCodeFetch(
    '/global/event',
    { signal: transportController.signal },
    input.workingDirectory,
  );
  if (!eventResponse.ok) {
    throw new Error('无法连接 OpenCode 事件流：HTTP ' + eventResponse.status);
  }

  const sessionResponse = await openCodeFetch(
    '/session?directory=' + directory,
    {
      method: 'POST',
      body: JSON.stringify({
        title: 'agentic-data-architect · ' + input.model,
      }),
    },
    input.workingDirectory,
  );
  if (!sessionResponse.ok) {
    throw new Error('无法创建 OpenCode Session：HTTP ' + sessionResponse.status);
  }

  const session = await sessionResponse.json() as { id?: string };
  sessionId = session.id ?? '';
  if (!sessionId) throw new Error('OpenCode 返回的 Session 没有 id。');
  const abort = async () => {
    transportController.abort();
    await abortOpenCodeSession(sessionId);
  };
  if (input.turnId) activeOpenCodeTurns.set(input.turnId, abort);

  input.onTrajectory?.({
    type: 'turn_start',
    name: 'OpenCode 本机 Agent 开始',
    status: 'started',
    model: input.model,
    details: {
      sessionId,
      providerId,
      modelId,
      workingDirectory: input.workingDirectory,
    },
  });

  let eventReaderTask: Promise<void> | undefined;
  try {
    eventReaderTask = consumeOpenCodeEvents(eventResponse, input, sessionId);

    const response = await openCodeFetch(
      '/session/' + encodeURIComponent(sessionId) + '/message',
      {
        method: 'POST',
        body: JSON.stringify({
          model: { providerID: providerId, modelID: modelId },
          system: input.systemPrompt,
          parts: [{ type: 'text', text: input.prompt }],
        }),
      },
      input.workingDirectory,
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('OpenCode 执行失败：HTTP ' + response.status + (detail ? ' · ' + detail.slice(0, 500) : ''));
    }

    const result = await response.json() as unknown;
    const extracted = extractTextParts(result);
    if (!extracted.answer) {
      const detail = JSON.stringify(result).slice(0, 1200);
      throw new Error('OpenCode 没有返回文本答案。' + (detail ? ' 返回内容：' + detail : ''));
    }

    // message endpoint 已经等待本轮完成。事件流只负责把过程实时推送到 UI。
    // 某些 OpenCode 版本可能继续保留 SSE 连接，因此在最终答案确定后不再等待它。
    void eventReaderTask.catch(() => undefined);

    input.onTrajectory?.({
      type: 'assistant_turn_end',
      name: 'OpenCode 本机 Agent 完成',
      status: 'completed',
      model: input.model,
      details: {
        sessionId,
        providerId,
        modelId,
      },
    });
    return extracted.answer;
  } catch (error) {
    void eventReaderTask?.catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    input.onTrajectory?.({
      type: 'error',
      name: 'OpenCode 本机 Agent 失败',
      status: 'failed',
      model: input.model,
      details: {
        error: message,
      },
    });
    throw error;
  }
}
