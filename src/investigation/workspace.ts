import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export type WorkspaceInputKind =
  | 'user_prompt'
  | 'question'
  | 'discovery'
  | 'research'
  | 'decision'
  | 'note';

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
}

export interface WorkspaceContext {
  schemaVersion: 1;
  userPrompt: string;
  importantInformation: string[];
  inputs: WorkspaceInput[];
  updatedAt: string;
}

export interface WorkspaceSeed {
  userPrompt?: string;
  goal?: string;
  scope?: string[];
  systems?: string[];
}

export function workspaceRoot(name: string): string {
  return path.join(config.investigationDir, name, 'workspace');
}

export function contextFile(name: string): string {
  return path.join(workspaceRoot(name), 'context.json');
}

export function researchDir(name: string): string {
  return path.join(workspaceRoot(name), 'research');
}

export function findingsDir(name: string): string {
  return path.join(workspaceRoot(name), 'findings');
}

export function artifactsDir(name: string): string {
  return path.join(workspaceRoot(name), 'artifacts');
}

export function notesDir(name: string): string {
  return path.join(workspaceRoot(name), 'notes');
}

export async function ensureWorkspace(name: string, seed: WorkspaceSeed = {}): Promise<string> {
  const root = workspaceRoot(name);
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(path.join(root, 'inputs'), { recursive: true }),
    fs.mkdir(researchDir(name), { recursive: true }),
    fs.mkdir(path.join(researchDir(name), 'github'), { recursive: true }),
    fs.mkdir(path.join(researchDir(name), 'leanix'), { recursive: true }),
    fs.mkdir(path.join(researchDir(name), 'confluence'), { recursive: true }),
    fs.mkdir(path.join(researchDir(name), 'web'), { recursive: true }),
    fs.mkdir(findingsDir(name), { recursive: true }),
    fs.mkdir(artifactsDir(name), { recursive: true }),
    fs.mkdir(notesDir(name), { recursive: true }),
    fs.mkdir(path.join(root, 'sources', 'github'), { recursive: true }),
  ]);

  const fp = contextFile(name);
  try {
    await fs.access(fp);
    return root;
  } catch {
    const now = new Date().toISOString();
    const context: WorkspaceContext = {
      schemaVersion: 1,
      userPrompt: seed.userPrompt ?? seed.goal ?? '',
      importantInformation: [],
      inputs: [],
      updatedAt: now,
    };
    const initialContent = JSON.stringify(
      {
        userPrompt: context.userPrompt,
        goal: seed.goal ?? '',
        scope: seed.scope ?? [],
        systems: seed.systems ?? [],
      },
      null,
      2,
    );
    if (context.userPrompt || seed.goal || seed.scope?.length || seed.systems?.length) {
      context.inputs.push({
        id: 'input-001',
        kind: 'user_prompt',
        capturedAt: now,
        title: 'Investigation initialization',
        content: initialContent,
        important: true,
      });
    }
    await fs.writeFile(fp, JSON.stringify(context, null, 2));
    return root;
  }
}

export async function loadWorkspaceContext(name: string): Promise<WorkspaceContext> {
  await ensureWorkspace(name);
  return JSON.parse(await fs.readFile(contextFile(name), 'utf-8')) as WorkspaceContext;
}

export async function appendContextInput(
  name: string,
  input: Omit<WorkspaceInput, 'id' | 'capturedAt'> & { id?: string; capturedAt?: string },
): Promise<WorkspaceInput> {
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
  };
  context.inputs.push(item);
  context.updatedAt = new Date().toISOString();
  await fs.writeFile(contextFile(name), JSON.stringify(context, null, 2));
  return item;
}

export async function addImportantInformation(name: string, information: string[]): Promise<void> {
  const context = await loadWorkspaceContext(name);
  for (const item of information) {
    const value = item.trim();
    if (value && !context.importantInformation.includes(value)) {
      context.importantInformation.push(value);
    }
  }
  context.updatedAt = new Date().toISOString();
  await fs.writeFile(contextFile(name), JSON.stringify(context, null, 2));
}
