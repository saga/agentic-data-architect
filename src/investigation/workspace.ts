/**
 * Workspace 文件系统状态、原子写和并发保护。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
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

/** 校验 Session 名称只能是单层安全路径名，阻止通过 workspace 路径逃逸。 */
function safeName(name: string): string {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Invalid Session name: ' + name);
  }
  return name;
}

/** 返回指定 Investigation 的工作目录；同时执行 Session 名称安全校验。 */
export function workspaceRoot(name: string): string {
  return path.join(config.workspaceDir, safeName(name));
}

/** 返回 context.json 的标准路径。 */
export function contextFile(name: string): string {
  return path.join(workspaceRoot(name), 'context.json');
}

// Replace the target in one rename so readers never observe a half-written JSON document.
/** 使用临时文件+rename 原子替换 JSON，避免读取者看到半写入文件。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, '.tmp-' + randomUUID() + '-' + path.basename(file));
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

const contextWriteLocks = new Map<string, Promise<void>>();
const sharedIndexWriteLocks = new Map<string, Promise<void>>();

/** 串行化全局 shared index 的读改写操作，防止不同 Session 覆盖彼此的 Artifact。 */
async function withSharedIndexWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = sharedIndexWriteLocks.get('shared') ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  sharedIndexWriteLocks.set('shared', queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sharedIndexWriteLocks.get('shared') === queued) sharedIndexWriteLocks.delete('shared');
  }
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
  const previous = contextWriteLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  contextWriteLocks.set(name, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (contextWriteLocks.get(name) === queued) contextWriteLocks.delete(name);
  }
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

  // Creation of the shared index is serialized with later read-modify-write updates,
  // so the first uploaded/shared artifact cannot be lost by a concurrent initializer.
  await ensureSharedIndex();

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
}

/** 读取并通过 Runtime Schema 校验当前 WorkspaceContext。 */
export async function loadWorkspaceContext(name: string): Promise<WorkspaceContext> {
  await ensureWorkspace(name);
  const raw = JSON.parse(await fs.readFile(contextFile(name), 'utf-8')) as unknown;
  return WorkspaceContextSchema.parse(raw);
}

// All context mutations must serialize against other mutations in the same session.
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

/** 把可恢复的 Copilot Session ID 和对应状态版本写回 Workspace。 */
/** 持久化可恢复的 Copilot Session，并绑定它所对应的 Investigation 配置版本。 */
export async function setCopilotSessionId(
  name: string,
  sessionId: string,
  configurationVersion?: number,
): Promise<void> {
  await withWorkspaceContextLock(name, async () => {
    const context = await loadWorkspaceContext(name);
    context.copilotSessionId = sessionId;
    if (typeof configurationVersion === 'number') {
      context.copilotConfigurationVersion = configurationVersion;
    }
    context.updatedAt = new Date().toISOString();
    await writeJsonAtomic(contextFile(name), context);
  });
}

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
  await fs.appendFile(transcriptFile(name), text, 'utf-8');
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