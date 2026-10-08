/**
 * Workspace 文件系统状态、原子写和并发保护。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import type { EvidenceRef } from '../evidence/types.js';
import {
  SharedIndexSchema,
  WorkspaceContextSchema,
  type WorkspaceContext,
  type WorkspaceInput,
  type WorkspaceSeed,
  type SharedArtifactIndexEntry,
  type SharedIndex,
} from './schemas.js';

export type { WorkspaceContext, WorkspaceInput, WorkspaceSeed, SharedArtifactIndexEntry, SharedIndex } from './schemas.js';

/** 统一 Investigation 名称；macOS 默认大小写不敏感，因此文件系统和 SQLite 必须使用同一大小写。 */
export function normalizeInvestigationName(name: string): string {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('调查名称不正确：只能使用单层目录名。');
  }
  return process.platform === 'darwin' ? name.toLowerCase() : name;
}

function safeName(name: string): string {
  return normalizeInvestigationName(name);
}

/** 返回指定 Investigation 的工作目录；同时执行 Session 名称安全校验。 */
export function workspaceRoot(name: string): string {
  return path.join(config.workspaceDir, safeName(name));
}

/** 返回 context.json 的标准路径。 */
export function contextFile(name: string): string {
  return path.join(workspaceRoot(name), 'context.json');
}

// 先完整写入临时文件，再一次 rename 替换目标文件；读取者要么看到旧文件，要么看到完整新文件，
// 不会看到只写了一半的 JSON / Markdown。原子写解决“进程被打断留下半文件”，
 // 并不等于多文件事务；调用方仍需要通过 provenance / version 校验整体状态。
/** 使用临时文件 + rename 原子替换任意文本文件。 */
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, '.tmp-' + randomUUID() + '-' + path.basename(file));
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, file);
}

/** 使用原子文本写入保存 JSON；不让读取者看到半写入的 JSON。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(value, null, 2));
}

const contextWriteLocks = new Map<string, Promise<void>>();
const workspaceInitializationLocks = new Map<string, Promise<void>>();
const transcriptWriteLocks = new Map<string, Promise<void>>();
const sharedIndexWriteLocks = new Map<string, Promise<void>>();
const contextLockOwners = new AsyncLocalStorage<Set<string>>();
const sharedIndexLockOwners = new AsyncLocalStorage<boolean>();

/** 串行化全局 shared index 的读改写操作，防止不同 Session 覆盖彼此的 Artifact。 */
async function withSharedIndexWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  if (sharedIndexLockOwners.getStore()) return operation();
  const previous = sharedIndexWriteLocks.get('shared') ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  sharedIndexWriteLocks.set('shared', queued);
  await previous.catch(() => undefined);
  const owner = true;
  return sharedIndexLockOwners.run(owner, async () => {
    try {
      return await operation();
    } finally {
      release();
      if (sharedIndexWriteLocks.get('shared') === queued) sharedIndexWriteLocks.delete('shared');
    }
  });
}

/** 确保 shared/index.json 存在；只负责初始化，不持有外层锁。 */
async function ensureSharedIndexFile(): Promise<void> {
  try {
    await fs.access(sharedIndexFile());
    return;
  } catch {
    await writeJsonAtomic(sharedIndexFile(), {
      schemaVersion: 1,
      artifacts: [],
      updatedAt: new Date().toISOString(),
    } satisfies SharedIndex);
  }
}

async function ensureSharedIndex(): Promise<void> {
  await withSharedIndexWriteLock(() => ensureSharedIndexFile());
}

/** 串行化同一 Session 的 context.json 修改，保护并发请求和 Agent commit。 */
export async function withWorkspaceContextLock<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owners = contextLockOwners.getStore();
  if (owners?.has(name)) return operation();
  const previous = contextWriteLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  contextWriteLocks.set(name, queued);

  await previous.catch(() => undefined);
  const nextOwners = new Set(owners ?? []);
  nextOwners.add(name);
  return contextLockOwners.run(nextOwners, async () => {
    try {
      return await operation();
    } finally {
      release();
      if (contextWriteLocks.get(name) === queued) contextWriteLocks.delete(name);
    }
  });
}

/** 返回 Investigation transcript.md 路径。 */
export function transcriptFile(name: string): string {
  return path.join(workspaceRoot(name), 'transcript.md');
}

/** 返回 Discovery 快照目录。 */
export function discoveryDir(name: string): string {
  return path.join(workspaceRoot(name), 'discovery');
}

/** 返回 Investigation 报告目录。 */
export function reportsDir(name: string): string {
  return path.join(workspaceRoot(name), 'reports');
}

/** 返回 Investigation artifact 目录。 */
export function artifactsDir(name: string): string {
  return path.join(workspaceRoot(name), 'artifacts');
}

/** Session-only cache; unlike shared/global cache it is disposable with the Investigation workspace. */
export function sessionCacheDir(name: string): string {
  return path.join(workspaceRoot(name), '.cache');
}

/** 返回跨 Investigation 的 shared 目录。 */
export function sharedDir(): string {
  return config.sharedDir;
}

/** 返回指定共享 Artifact 类型的存储目录。 */
export function sharedArtifactDir(kind: SharedArtifactIndexEntry['kind']): string {
  return path.join(config.sharedDir, kind);
}

/** 返回共享 Artifact 索引文件路径。 */
export function sharedIndexFile(): string {
  return path.join(config.sharedDir, 'index.json');
}

/** 对连接串 URI 中的用户名、密码和常见 secret 参数脱敏，用于日志和 Evidence 描述。 */
export function redactSensitiveUri(value: string): string {
  try {
    const u = new URL(value);
    if (u.username) u.username = 'REDACTED';
    if (u.password) u.password = 'REDACTED';
    for (const key of ['token', 'access_token', 'api_key', 'apikey', 'secret', 'password']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, 'REDACTED');
    }
    return u.toString();
  } catch {
    return value.replace(/((?:password|token|secret|api[_-]?key)=)[^&\s]+/gi, '$1REDACTED');
  }
}

/** 创建 Investigation 所需目录和初始 context/transcript；已有 workspace 时保持现有状态。 */
export async function ensureWorkspace(name: string, seed: WorkspaceSeed = {}): Promise<string> {
  const root = workspaceRoot(name);
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(discoveryDir(name), { recursive: true }),
    fs.mkdir(reportsDir(name), { recursive: true }),
    fs.mkdir(artifactsDir(name), { recursive: true }),
    fs.mkdir(sessionCacheDir(name), { recursive: true }),
    fs.mkdir(config.sharedDir, { recursive: true }),
    ...(['confluence', 'github', 'leanix', 'web', 'document', 'other'] as const).map((kind) =>
      fs.mkdir(sharedArtifactDir(kind), { recursive: true }),
    ),
  ]);

  // Shared index 有独立的全局锁；这里不能和单个 Investigation 的 context lock 混用，
  // 否则两个 Session 同时首次启动时会出现跨资源的锁依赖。
  await ensureSharedIndex();

  // “目录存在”与“context.json 已存在”是两个不同状态。
  // 多个 API/Tool 可能同时第一次访问同一 Investigation；如果这里不做二次串行化，
  // 两个请求都会看到 ENOENT，然后后写入者会把先写入者的初始 seed 静默覆盖掉。
  const previous = workspaceInitializationLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const queued = previous.catch(() => undefined).then(
    () => new Promise<void>((resolve) => { release = resolve; }),
  );
  workspaceInitializationLocks.set(root, queued);
  await previous.catch(() => undefined);

  try {
    const fp = contextFile(name);
    try {
      await fs.access(fp);
      return root;
    } catch {
      const now = new Date().toISOString();
      const context: WorkspaceContext = {
        schemaVersion: 3,
        name,
        userPrompt: seed.userPrompt ?? seed.goal ?? '',
        workflow: seed.workflow ?? null,
        // 创建 Investigation 时没有单独的 goal 输入，因此第一句任务描述就是 goal。
        goal: seed.goal?.trim() || seed.userPrompt?.trim() || '',
        scope: seed.scope ?? [],
        systems: seed.systems ?? [],
        questions: [],
        discoveryRuns: [],
        evidence: [],
        claims: [],
        findings: [],
        unknowns: [],
        importantInformation: [],
        inputs: [],
        updatedAt: now,
      };
      if (context.userPrompt || context.goal || context.scope.length || context.systems.length) {
        context.inputs.push({
          id: 'input-001',
          kind: 'user_prompt',
          capturedAt: now,
          title: 'Session initialization',
          content: JSON.stringify({
            userPrompt: context.userPrompt,
            goal: context.goal,
            scope: context.scope,
            systems: context.systems,
          }, null, 2),
          important: true,
        });
      }
      const validatedContext = WorkspaceContextSchema.parse(context);
      await writeJsonAtomic(fp, validatedContext);
      await fs.writeFile(transcriptFile(name), '# Investigation Session ' + name + '\n\n');
      return root;
    }
  } finally {
    release();
    if (workspaceInitializationLocks.get(root) === queued) {
      workspaceInitializationLocks.delete(root);
    }
  }
}

/** 读取并通过 Runtime Schema 校验当前 WorkspaceContext。 */
export async function loadWorkspaceContext(name: string): Promise<WorkspaceContext> {
  await ensureWorkspace(name);
  const raw = JSON.parse(await fs.readFile(contextFile(name), 'utf-8')) as unknown;
  return WorkspaceContextSchema.parse(raw);
}

// 同一 Investigation 的所有 context 修改都必须经过同一把锁，避免两个请求基于不同快照互相覆盖。
/** 向 Workspace inputs 追加一条输入事件，并在同一 Session 锁内原子保存。 */
export async function appendContextInput(
  name: string,
  input: Omit<WorkspaceInput, 'id' | 'capturedAt'> & { id?: string; capturedAt?: string },
): Promise<WorkspaceInput> {
  return withWorkspaceContextLock(name, async () => {
    const context = await loadWorkspaceContext(name);
    const item: WorkspaceInput = {
      id: input.id ?? 'input-' + String(context.inputs.length + 1).padStart(3, '0'),
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      kind: input.kind,
      title: input.title,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.uri !== undefined ? { uri: input.uri } : {}),
      ...(input.artifactPath !== undefined ? { artifactPath: input.artifactPath } : {}),
      ...(input.important !== undefined ? { important: input.important } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
    };
    context.inputs.push(item);
    if (!context.userPrompt && input.kind === 'user_message' && input.content?.trim()) {
      context.userPrompt = input.content.trim();
    }
    context.updatedAt = new Date().toISOString();
    await writeJsonAtomic(contextFile(name), context);
    return item;
  });
}

/** 向当前 Investigation 追加去重后的重要上下文信息。 */
export async function addImportantInformation(name: string, information: string[]): Promise<void> {
  await withWorkspaceContextLock(name, async () => {
    const context = await loadWorkspaceContext(name);
    for (const item of information) {
      const value = item.trim();
      if (value && !context.importantInformation.includes(value)) context.importantInformation.push(value);
    }
    context.updatedAt = new Date().toISOString();
    await writeJsonAtomic(contextFile(name), context);
  });
}

/** 持久化可恢复的 Agent Session，并绑定它所对应的 Investigation 配置版本和 Runtime。 */
export async function setAgentSessionId(
  name: string,
  sessionId: string,
  configurationVersion?: number,
  runtime?: import('./schemas.js').AgentRuntime,
): Promise<void> {
  await withWorkspaceContextLock(name, async () => {
    const context = await loadWorkspaceContext(name);
    if (!runtime || runtime === 'copilot-sdk') {
      context.copilotSessionId = sessionId;
      if (typeof configurationVersion === 'number') {
        context.copilotConfigurationVersion = configurationVersion;
      }
    }
    if (runtime) {
      context.agentSessionId = sessionId;
      context.agentSessionRuntime = runtime;
      context.agentConfigurationVersion = configurationVersion;
    }
    context.updatedAt = new Date().toISOString();
    await writeJsonAtomic(contextFile(name), context);
  });
}

/** Backward-compatible alias for older callers; new code should use setAgentSessionId. */
export const setCopilotSessionId = setAgentSessionId;

/** 在同一个 Investigation 的 context.json 中追加一条 Evidence，避免 Agent 工具直接改写状态文件。 */
export async function appendInvestigationEvidence(
  name: string,
  evidence: EvidenceRef,
): Promise<void> {
  await withWorkspaceContextLock(name, async () => {
    const context = await loadWorkspaceContext(name);
    if (context.evidence.some((item) => item.id === evidence.id)) return;
    context.evidence.push(evidence);
    context.updatedAt = new Date().toISOString();
    const validated = WorkspaceContextSchema.parse(context);
    await writeJsonAtomic(contextFile(name), validated);
  });
}

/** 追加人可读的 transcript.md 记录，用于人工回看，不作为唯一业务状态源。 */
export async function appendTranscript(name: string, role: 'user' | 'assistant' | 'system', content: string): Promise<void> {
  await ensureWorkspace(name);
  const label = role === 'assistant' ? 'Agent' : role === 'user' ? 'User' : 'System';
  const text = '## ' + label + ' — ' + new Date().toISOString() + '\n\n' + content.trim() + '\n\n';

  // transcript 是 append-only 记录，但多个异步任务仍可能同时追加，例如主回答、
  // Companion Note 和恢复处理。统一串行写入，避免 JSONL 之外的 Markdown 日志也出现顺序混乱。
  const previous = transcriptWriteLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  transcriptWriteLocks.set(name, queued);
  await previous.catch(() => undefined);
  try {
    await fs.appendFile(transcriptFile(name), text, 'utf-8');
  } finally {
    release();
    if (transcriptWriteLocks.get(name) === queued) transcriptWriteLocks.delete(name);
  }
}

/** 以读改写方式注册共享 Artifact，并在全局锁内原子更新 index.json。 */
export async function registerSharedArtifact(entry: Omit<SharedArtifactIndexEntry, 'updatedAt'>): Promise<void> {
  await withSharedIndexWriteLock(async () => {
    await fs.mkdir(config.sharedDir, { recursive: true });
    await ensureSharedIndexFile();
    const raw = SharedIndexSchema.parse(JSON.parse(await fs.readFile(sharedIndexFile(), 'utf-8')));
    const artifacts = raw.artifacts.filter((item) => item.id !== entry.id);
    artifacts.push({ ...entry, updatedAt: new Date().toISOString() });
    await writeJsonAtomic(sharedIndexFile(), {
      schemaVersion: 1,
      artifacts,
      updatedAt: new Date().toISOString(),
    });
  });
}

/** 保存共享文档内容并同步注册到 shared index。 */
export async function addSharedDocument(
  kind: SharedArtifactIndexEntry['kind'],
  id: string,
  title: string,
  content: string,
  metadata: Omit<SharedArtifactIndexEntry, 'id' | 'kind' | 'path' | 'title' | 'updatedAt'> = {},
): Promise<string> {
  const dir = sharedArtifactDir(kind);
  await fs.mkdir(dir, { recursive: true });
  const safeId = id.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);
  const relativePath = path.posix.join('shared', kind, safeId + '.md');
  const file = path.join(config.workspaceDir, relativePath);
  await fs.writeFile(file, content, 'utf-8');
  await registerSharedArtifact({ id, kind, path: relativePath, title, ...metadata });
  return relativePath;
}