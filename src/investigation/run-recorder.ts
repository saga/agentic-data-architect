import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceRoot } from './workspace.js';

/**
 * 本地 Investigation 原始运行录制器。
 *
 * 目的不是替代 trajectory，而是保留一次真实运行中足够完整的输入/输出，
 * 方便事后分析 Agent 为什么偏离目标。文件只写本机 .workspace，不进入 Git。
 * 不记录模型隐藏推理正文；assistant response、tool 参数/结果、permission、
 * user input 和每次 sendAndWait prompt 都会记录。
 */
export interface RunRecorder {
  runId: string;
  write(type: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
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
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(workspaceRoot(name), 'runs', runId);
  const file = path.join(directory, 'events.jsonl');
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
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ runId, startedAt: new Date().toISOString(), ...manifestMetadata }, null, 2) + '\n',
    'utf8',
  );

  return {
    runId,
    write,
    async close() {
      await chain;
      closed = true;
    },
  };
}
