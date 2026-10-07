import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceRoot, writeJsonAtomic } from './workspace.js';

/**
 * 本地 Investigation 原始运行录制器。
 *
 * 这里保存的是“运行事实”，不是第二套业务状态：
 * - events.jsonl 记录模型请求、工具调用、工具结果、用户输入和运行结束状态；
 * - reasoning.jsonl 单独保存秘书/Agent 的可展示 reasoning delta，避免和操作事件混在一起；
 * - manifest.json 记录一次原始运行的生命周期、耗时和最终状态。
 *
 * 写入必须保持串行且可观察。尤其 reasoning 不是可有可无的 UI 缓存：
 * 如果持久化失败，上层应该知道这次运行无法满足完整审计要求，而不能悄悄当成成功。
 * 记录内容会做明显凭证字段脱敏，但不会为了“安全”把普通代码、参数和分析结果一起删掉。
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
  source = 'agent',
): Promise<void> {
  const value = delta.trim();
  if (!value) return Promise.resolve();
  const key = name + ':' + turnId;
  const previous = reasoningWriteChains.get(key) ?? Promise.resolve();
  const file = path.join(workspaceRoot(name), 'runs', 'reasoning.jsonl');
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    turnId,
    source,
    delta,
  }) + '\n';
  // 队列本身即使前一条写入失败也不能被“毒死”，否则后续 reasoning 永远不会再尝试；
  // 但当前这一次 append 必须把错误返回给调用方，让 answerQuestion 决定是否停止本轮。
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, record, 'utf8');
    })
    .catch((error) => {
      console.error('[reasoning-log] Failed to persist reasoning delta.', {
        sessionName: name,
        turnId,
        source,
        error,
      });
      throw error;
    });
  let queued: Promise<void>;
  queued = next.catch(() => undefined).finally(() => {
    if (reasoningWriteChains.get(key) === queued) reasoningWriteChains.delete(key);
  });
  reasoningWriteChains.set(key, queued);
  return next;
}
