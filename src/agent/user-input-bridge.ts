import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export interface AgentUserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

export interface PendingAgentUserInput {
  sessionName: string;
  turnId: string;
  sessionId: string;
  requestId: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  requestedAt: string;
}

interface PendingEntry extends PendingAgentUserInput {
  onAnswered?: (response: { answer: string; wasFreeform: boolean }) => void;
  resolve: (response: { answer: string; wasFreeform: boolean }) => void;
  reject: (error: Error) => void;
}

const pending = new Map<string, PendingEntry>();

function redact(value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(redact);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      result[key] = /token|secret|password|authorization|api[-_]?key|cookie/i.test(key)
        ? '[已隐藏]'
        : redact(item);
    }
    return result;
  }
  return String(value);
}

export function listPendingAgentUserInputs(sessionName: string): PendingAgentUserInput[] {
  return [...pending.values()]
    .filter((item) => item.sessionName === sessionName)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .map(({ resolve: _resolve, reject: _reject, onAnswered: _onAnswered, ...item }) => ({ ...item }));
}

export function respondToAgentUserInput(
  sessionName: string,
  turnId: string,
  requestId: string,
  answer: string,
  wasFreeform: boolean,
): boolean {
  const entry = pending.get(requestId);
  if (!entry || entry.sessionName !== sessionName || entry.turnId !== turnId) return false;
  const value = answer.trim();
  if (!value) return false;
  if (!wasFreeform && !entry.choices.includes(value)) return false;

  pending.delete(requestId);
  entry.onAnswered?.({ answer: value, wasFreeform });
  entry.resolve({ answer: value, wasFreeform });
  return true;
}

export async function requestAgentUserInput(
  sessionName: string,
  turnId: string,
  sessionId: string,
  request: AgentUserInputRequest,
  onStatus?: (status: string) => void,
  onTrajectory?: (event: {
    type: 'user_input_requested' | 'user_input_completed' | 'status';
    name: string;
    status?: 'started' | 'completed' | 'waiting' | 'info';
    durationMs?: number;
    details?: Record<string, unknown>;
  }) => void,
): Promise<{ answer: string; wasFreeform: boolean }> {
  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  const choices = request.choices ?? [];
  onStatus?.('助手正在等你的回答。');
  onTrajectory?.({
    type: 'user_input_requested',
    name: '等待你的回答',
    status: 'waiting',
    details: {
      requestId,
      waitingOn: 'user_input',
      question: request.question,
      choices: choices.map(redact),
      waitTimeoutMs: config.userInputWaitTimeoutMs,
    },
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`等待你的回答超过 ${config.userInputWaitTimeoutMs}ms，这次操作已停止。`));
    }, config.userInputWaitTimeoutMs);
    timeoutId.unref?.();

    pending.set(requestId, {
      sessionName,
      turnId,
      sessionId,
      requestId,
      question: request.question,
      choices,
      allowFreeform: request.allowFreeform !== false,
      requestedAt,
      onAnswered: ({ answer, wasFreeform }) => {
        clearTimeout(timeoutId);
        onTrajectory?.({
          type: 'user_input_completed',
          name: '用户输入已提供',
          status: 'completed',
          durationMs: Math.max(0, Date.now() - Date.parse(requestedAt)),
          details: {
            requestId,
            question: redact(request.question),
            answer: redact(answer),
            wasFreeform,
          },
        });
      },
      resolve,
      reject,
    });
  });
}

export function rejectAllPendingAgentUserInputs(error = new Error('助手运行已经结束。')): void {
  for (const entry of pending.values()) {
    entry.reject(error);
  }
  pending.clear();
}
