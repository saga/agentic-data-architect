import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import type { Claim, DiscoveryRun, EvidenceRef, Finding } from '../evidence/types.js';
import { migrateLegacyConversationInputs } from './conversation.js';

export type WorkspaceInputKind =
  | 'user_prompt'
  | 'user_message'
  | 'assistant_message'
  | 'question'
  | 'discovery'
  | 'research'
  | 'decision'
  | 'note'
  | 'document';

export interface WorkspaceInput {
  id: string;
  kind: WorkspaceInputKind;
  capturedAt: string;
  title: string;
  content?: string;
  source?: string;
  uri?: string;
  artifactPath?: string;
  important?: boolean;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface WorkspaceContext {
  schemaVersion: 3;
  name: string;
  userPrompt: string;
  goal: string;
  scope: string[];
  systems: string[];
  questions: string[];
  discoveryRuns: DiscoveryRun[];
  evidence: EvidenceRef[];
  claims: Claim[];
  findings: Finding[];
  unknowns: string[];
  importantInformation: string[];
  inputs: WorkspaceInput[];
  copilotSessionId?: string;
  copilotConfigurationVersion?: number;
  updatedAt: string;
}

export interface WorkspaceSeed {
  userPrompt?: string;
  goal?: string;
  scope?: string[];
  systems?: string[];
}

export interface SharedArtifactIndexEntry {
  id: string;
  kind: 'confluence' | 'github' | 'leanix' | 'web' | 'document' | 'other';
  path: string;
  title: string;
  source?: string;
  uri?: string;
  updatedAt: string;
  sessionNames?: string[];
}

export interface SharedIndex {
  schemaVersion: 1;
  artifacts: SharedArtifactIndexEntry[];
  updatedAt: string;
}

function safeName(name: string): string {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Invalid Session name: ' + name);
  }
  return name;
}

export function workspaceRoot(name: string): string {
  return path.join(config.workspaceDir, safeName(name));
}

export function contextFile(name: string): string {
  return path.join(workspaceRoot(name), 'context.json');
}

// Replace the target in one rename so readers never observe a half-written JSON document.
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, '.tmp-' + randomUUID() + '-' + path.basename(file));
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

const contextWriteLocks = new Map<string, Promise<void>>();
const sharedIndexWriteLocks = new Map<string, Promise<void>>();

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

export function transcriptFile(name: string): string {
  return path.join(workspaceRoot(name), 'transcript.md');
}

export function discoveryDir(name: string): string {
  return path.join(workspaceRoot(name), 'discovery');
}

export function reportsDir(name: string): string {
  return path.join(workspaceRoot(name), 'reports');
}

export function artifactsDir(name: string): string {
  return path.join(workspaceRoot(name), 'artifacts');
}

export function sharedDir(): string {
  return config.sharedDir;
}

export function sharedArtifactDir(kind: SharedArtifactIndexEntry['kind']): string {
  return path.join(config.sharedDir, kind);
}

export function sharedIndexFile(): string {
  return path.join(config.sharedDir, 'index.json');
}

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

export async function ensureWorkspace(name: string, seed: WorkspaceSeed = {}): Promise<string> {
  const root = workspaceRoot(name);
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(discoveryDir(name), { recursive: true }),
    fs.mkdir(reportsDir(name), { recursive: true }),
    fs.mkdir(artifactsDir(name), { recursive: true }),
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
      goal: seed.goal ?? '',
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
    await writeJsonAtomic(fp, context);
    await fs.writeFile(transcriptFile(name), '# Investigation Session ' + name + '\n\n');
    return root;
  }
}

export async function loadWorkspaceContext(name: string): Promise<WorkspaceContext> {
  await ensureWorkspace(name);
  const raw = JSON.parse(await fs.readFile(contextFile(name), 'utf-8')) as Partial<WorkspaceContext>;
  const context: WorkspaceContext = {
    schemaVersion: 3,
    name,
    userPrompt: raw.userPrompt ?? '',
    goal: raw.goal ?? '',
    scope: raw.scope ?? [],
    systems: raw.systems ?? [],
    questions: raw.questions ?? [],
    discoveryRuns: raw.discoveryRuns ?? [],
    evidence: raw.evidence ?? [],
    claims: raw.claims ?? [],
    findings: raw.findings ?? [],
    unknowns: raw.unknowns ?? [],
    importantInformation: raw.importantInformation ?? [],
    inputs: raw.inputs ?? [],
    ...(raw.copilotSessionId ? { copilotSessionId: raw.copilotSessionId } : {}),
    ...(typeof raw.copilotConfigurationVersion === 'number' ? { copilotConfigurationVersion: raw.copilotConfigurationVersion } : {}),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };

  const remainingInputs = migrateLegacyConversationInputs(name, context.inputs);
  if (remainingInputs.length !== context.inputs.length) {
    context.inputs = remainingInputs;
    context.updatedAt = new Date().toISOString();
    await writeJsonAtomic(contextFile(name), context);
  }

  return context;
}

// All context mutations must serialize against other mutations in the same session.
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

export async function setCopilotSessionId(name: string, sessionId: string): Promise<void> {
  await withWorkspaceContextLock(name, async () => {
    const context = await loadWorkspaceContext(name);
    context.copilotSessionId = sessionId;
    context.updatedAt = new Date().toISOString();
    await writeJsonAtomic(contextFile(name), context);
  });
}

export async function appendTranscript(name: string, role: 'user' | 'assistant' | 'system', content: string): Promise<void> {
  await ensureWorkspace(name);
  const label = role === 'assistant' ? 'Agent' : role === 'user' ? 'User' : 'System';
  const text = '## ' + label + ' — ' + new Date().toISOString() + '\n\n' + content.trim() + '\n\n';
  await fs.appendFile(transcriptFile(name), text, 'utf-8');
}

export async function registerSharedArtifact(entry: Omit<SharedArtifactIndexEntry, 'updatedAt'>): Promise<void> {
  await withSharedIndexWriteLock(async () => {
    await fs.mkdir(config.sharedDir, { recursive: true });
    await ensureSharedIndexFile();
    const raw = JSON.parse(await fs.readFile(sharedIndexFile(), 'utf-8')) as SharedIndex;
    const artifacts = raw.artifacts.filter((item) => item.id !== entry.id);
    artifacts.push({ ...entry, updatedAt: new Date().toISOString() });
    await writeJsonAtomic(sharedIndexFile(), {
      schemaVersion: 1,
      artifacts,
      updatedAt: new Date().toISOString(),
    });
  });
}

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