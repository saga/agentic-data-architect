/**
 * Durable, provider-level health memory.
 *
 * Only actionable provider failures are persisted. Tool/Skill/business errors must not
 * make a provider look unavailable. A known quota/auth/connectivity failure survives a
 * server restart so new Investigations do not keep selecting the same broken default.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { AgentRuntime } from '../investigation/schemas.js';

export type ProviderFailureCategory = 'quota_exhausted' | 'authentication_error' | 'connection_error';

export interface ProviderFailure {
  runtime: AgentRuntime;
  category: ProviderFailureCategory;
  message: string;
  model?: string;
  failedAt: string;
}

const statePath = path.join(config.dataDir, 'agent-provider-health.json');
let cachedState: Partial<Record<AgentRuntime, ProviderFailure>> | undefined;
let loadingState: Promise<Partial<Record<AgentRuntime, ProviderFailure>>> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let revision = 0;

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-token]')
    .replace(/\b(password|token|secret|authorization)\s*([=:])\s*\S+/gi, '$1$2[redacted]')
    .slice(0, 700);
}

export function classifyProviderFailure(error: unknown): ProviderFailureCategory | undefined {
  const message = safeMessage(error);
  if (/monthly quota|quota (?:has been )?exhausted|exceeded (?:your|the) .*quota|usage limit (?:has been )?reached|credits? (?:are )?(?:exhausted|depleted)/i.test(message)) {
    return 'quota_exhausted';
  }
  if (/unauthori[sz]ed|authentication failed|not authenticated|not logged in|please (?:log|sign) in|invalid (?:api )?key|expired token|token is invalid|HTTP\s*(?:401|403)|status(?:\s+code)?\s*(?:401|403)/i.test(message)) {
    return 'authentication_error';
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN)\b|fetch failed|connection (?:was )?(?:refused|reset|closed|unavailable)|HTTP\s*5\d\d/i.test(message)) {
    return 'connection_error';
  }
  return undefined;
}

async function loadState(): Promise<Partial<Record<AgentRuntime, ProviderFailure>>> {
  if (cachedState) return cachedState;
  if (loadingState) return loadingState;

  loadingState = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown;
      const source = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      const next: Partial<Record<AgentRuntime, ProviderFailure>> = {};
      for (const runtime of ['copilot-sdk', 'codebuddy-sdk', 'opencode-run'] as const) {
        const item = source[runtime];
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (
          record.runtime === runtime
          && ['quota_exhausted', 'authentication_error', 'connection_error'].includes(String(record.category))
          && typeof record.message === 'string'
          && typeof record.failedAt === 'string'
        ) {
          next[runtime] = {
            runtime,
            category: record.category as ProviderFailureCategory,
            message: safeMessage(record.message),
            ...(typeof record.model === 'string' ? { model: record.model } : {}),
            failedAt: record.failedAt,
          };
        }
      }
      cachedState = next;
      return next;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
        console.warn('[provider-health] Could not read persisted provider health; starting with an empty snapshot.', error);
      }
      cachedState = {};
      return cachedState;
    } finally {
      loadingState = undefined;
    }
  })();
  return loadingState;
}

async function persistState(next: Partial<Record<AgentRuntime, ProviderFailure>>): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = statePath + '.tmp-' + process.pid;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await fs.rename(tempPath, statePath);
}

async function updateState(
  update: (state: Partial<Record<AgentRuntime, ProviderFailure>>) => void,
): Promise<void> {
  const operation = writeQueue.then(async () => {
    const current = { ...await loadState() };
    update(current);
    await persistState(current);
    cachedState = current;
    revision += 1;
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
}

export async function getProviderFailures(): Promise<Partial<Record<AgentRuntime, ProviderFailure>>> {
  const state = await loadState();
  return { ...state };
}

export function getProviderHealthRevision(): number {
  return revision;
}

export async function recordProviderFailure(
  runtime: AgentRuntime,
  model: string | undefined,
  error: unknown,
): Promise<ProviderFailure | undefined> {
  const category = classifyProviderFailure(error);
  if (!category) return undefined;

  const record: ProviderFailure = {
    runtime,
    category,
    message: safeMessage(error),
    ...(model ? { model } : {}),
    failedAt: new Date().toISOString(),
  };
  await updateState((state) => { state[runtime] = record; });
  console.warn('[provider-health] Provider marked unavailable after an actionable provider failure.', record);
  return record;
}

export async function clearProviderFailure(runtime: AgentRuntime): Promise<void> {
  const current = await loadState();
  if (!current[runtime]) return;
  await updateState((state) => { delete state[runtime]; });
  console.info('[provider-health] Cleared the stored unavailability marker after a retry/success.', { runtime });
}

/** Successful model execution confirms that the Runtime is usable again. */
export const recordProviderSuccess = clearProviderFailure;
