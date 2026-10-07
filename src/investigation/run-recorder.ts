import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceRoot, writeJsonAtomic } from './workspace.js';

/**
 * 本地 Investigation 原始运行录制器。
 *
 * 目的不是替代 trajectory，而是保留一次真实运行中足够完整的输入/输出，
 * 方便事后分析 Agent 为什么偏离目标。文件只写本机 .workspace，不进入 Git。
 * 不记录模型隐藏推理正文；assistant response、tool 参数/结果、permission、
 * user input 和每次 sendAndWait prompt 都会记录。
 */
export interface RunCloseResult {
  status: 'completed' | 'failed' | 'aborted';
  error?: string;
}

export interface RunRecorder {
  runId: string;
  write(type: string, payload: unknown): Promise<void>;
  close(result?: RunCloseResult): Promise<void>;
}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|cookie/i;

/** 只脱敏明显的凭证字段；研究所需的普通代码、路径、参数和响应保持原样。 */
export function redactRunRecording(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRunRecording);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactRunRecording(item);
  }
  return result;
}

export async function createRunRecorder(name: string, metadata: Record<string, unknown>): Promise<RunRecorder> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const directory = path.join(workspaceRoot(name), 'runs', runId);
  const file = path.join(directory, 'events.jsonl');
  const manifestFile = path.join(directory, 'manifest.json');
  await fs.mkdir(directory, { recursive: true });

  let closed = false;
  let chain = Promise.resolve();
  const write = (type: string, payload: unknown): Promise<void> => {
    if (closed) return Promise.resolve();
    const record = JSON.stringify({
      sequence: Date.now(),
      timestamp: new Date().toISOString(),
      type,
      data: redactRunRecording(payload),
    }) + '\n';
    chain = chain.then(() => fs.appendFile(file, record, 'utf8'));
    return chain;
  };

  await write('run_started', { runId, ...metadata });

  const safeMetadata = redactRunRecording(metadata);
  const manifestMetadata: Record<string, unknown> =
    safeMetadata && typeof safeMetadata === 'object' && !Array.isArray(safeMetadata)
      ? safeMetadata as Record<string, unknown>
      : {};
  await writeJsonAtomic(manifestFile, {
    runId,
    startedAt,
    status: 'running',
    ...manifestMetadata,
  });

  return {
    runId,
    write,
    async close(result = { status: 'completed' as const }) {
      await chain;
      if (closed) return;

      const completedAt = new Date().toISOString();
      await writeJsonAtomic(manifestFile, {
        runId,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        ...manifestMetadata,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      closed = true;
    },
  };
}


const reasoningWriteChains = new Map<string, Promise<void>>();

export function appendReasoningLog(
  name: string,
  turnId: string,
  delta: string,
): void {
  const value = delta.trim();
  if (!value) return;
  const key = name + ':' + turnId;
  const previous = reasoningWriteChains.get(key) ?? Promise.resolve();
  const file = path.join(workspaceRoot(name), 'runs', 'reasoning.jsonl');
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    turnId,
    delta,
  }) + '\n';
  const next = previous
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, record, 'utf8');
    })
    .catch((error) => {
      console.error('[reasoning-log] Failed to persist reasoning delta', {
        sessionName: name,
        turnId,
        error,
      });
    })
    .finally(() => {
      if (reasoningWriteChains.get(key) === next) reasoningWriteChains.delete(key);
    });
  reasoningWriteChains.set(key, next);
}
