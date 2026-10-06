import * as z from 'zod';
import { SseEventSchema, type SseEvent } from '../../../src/api/contracts.js';

export type StreamEvent = SseEvent;

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
    const body = await response.text();
    throw new Error(body || response.statusText);
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
