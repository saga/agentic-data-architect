import * as z from 'zod';
import { ApiErrorSchema, SseEventSchema, type ApiError, type SseEvent } from '../../../src/api/contracts.js';

export type StreamEvent = SseEvent;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly apiError: ApiError;

  constructor(status: number, apiError: ApiError) {
    super(apiError.error);
    this.name = 'ApiRequestError';
    this.status = status;
    this.apiError = apiError;
  }
}

async function readApiError(response: Response): Promise<ApiError> {
  const fallbackBody = () => response.clone().text().catch(() => '');
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    const body = await fallbackBody();
    return {
      code: 'HTTP_ERROR',
      error: body || response.statusText || '请求失败。',
    };
  }

  const parsed = ApiErrorSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  return {
    code: 'HTTP_ERROR',
    error: response.statusText || '请求失败。',
    ...(payload && typeof payload === 'object' ? { details: payload as Record<string, unknown> } : {}),
  };
}

export async function getText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readApiError(response));
  }
  return response.text();
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T>;
export async function getJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>;
export async function getJson<T>(
  url: string,
  schemaOrInit?: z.ZodType<T> | RequestInit,
  init?: RequestInit,
): Promise<T> {
  const looksLikeSchema = typeof schemaOrInit === 'object'
    && schemaOrInit !== null
    && 'parse' in schemaOrInit
    && typeof (schemaOrInit as { parse?: unknown }).parse === 'function';
  const schema = looksLikeSchema ? schemaOrInit as z.ZodType<T> : undefined;
  const requestInit = schema ? init : schemaOrInit as RequestInit | undefined;
  const response = await fetch(url, requestInit);
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readApiError(response));
  }
  const data: unknown = await response.json();
  return schema ? schema.parse(data) : data as T;
}

export async function consumeSse(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('当前环境不支持流式响应。');

  const decoder = new TextDecoder();
  let buffer = '';

  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n')) as unknown;
    onEvent(SseEventSchema.parse({ event, data: payload }));
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.trim()) processBlock(block);
    }
    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) processBlock(tail);
}
