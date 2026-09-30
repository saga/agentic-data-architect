import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  contextFile,
  discoveryDir,
  ensureWorkspace,
  workspaceRoot,
  type WorkspaceContext,
} from './workspace.js';
import { migrateLegacyConversationInputs } from './conversation.js';

export type Investigation = WorkspaceContext;

export function newInvestigation(name: string, userPrompt = ''): Investigation {
  return {
    schemaVersion: 2,
    name,
    userPrompt,
    goal: '',
    scope: [],
    systems: [],
    questions: [],
    discoveryRuns: [],
    evidence: [],
    claims: [],
    findings: [],
    unknowns: [],
    importantInformation: [],
    inputs: [],
    updatedAt: new Date().toISOString(),
  };
}

export function investigationRoot(name: string): string {
  return workspaceRoot(name);
}

export function investigationFile(name: string): string {
  return contextFile(name);
}

export function reportsDir(name: string): string {
  return path.join(investigationRoot(name), 'reports');
}

export async function saveInvestigation(inv: Investigation): Promise<string> {
  await ensureWorkspace(inv.name, {
    userPrompt: inv.userPrompt,
    goal: inv.goal,
    scope: inv.scope,
    systems: inv.systems,
  });
  inv.schemaVersion = 2;
  inv.updatedAt = new Date().toISOString();
  await fs.writeFile(contextFile(inv.name), JSON.stringify(inv, null, 2));
  return contextFile(inv.name);
}

export async function loadInvestigation(name: string): Promise<Investigation> {
  try {
    const raw = JSON.parse(await fs.readFile(contextFile(name), 'utf-8')) as Partial<Investigation>;
    const inv = normalizeInvestigation(name, raw);
    const remainingInputs = migrateLegacyConversationInputs(name, inv.inputs);
    if (remainingInputs.length !== inv.inputs.length) {
      inv.inputs = remainingInputs;
      await saveInvestigation(inv);
    }
    return inv;
  } catch (e) {
    if (!(e instanceof Error) || !('code' in e) || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const legacyCandidates = [
    path.join(config.legacyDataDir, 'investigations', name, 'investigation.json'),
    path.join(config.legacyDataDir, 'investigations', name + '.json'),
  ];
  for (const legacy of legacyCandidates) {
    try {
      const raw = JSON.parse(await fs.readFile(legacy, 'utf-8')) as Partial<Investigation>;
      const inv = normalizeInvestigation(name, raw);
      inv.inputs = migrateLegacyConversationInputs(name, inv.inputs);
      await saveInvestigation(inv);
      return inv;
    } catch (e) {
      if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }

  throw new Error('Investigation 不存在：' + name);
}

function normalizeInvestigation(name: string, raw: Partial<Investigation>): Investigation {
  return {
    schemaVersion: 2,
    name,
    userPrompt: raw.userPrompt ?? raw.goal ?? '',
    goal: raw.goal ?? '',
    scope: raw.scope ?? [],
    systems: raw.systems ?? [],
    questions: raw.questions ?? [],
    discoveryRuns: raw.discoveryRuns ?? [],
    evidence: raw.evidence ?? [],
    claims: (raw.claims ?? []).map((c, i) => ({
      id: c.id ?? ('legacy-' + i),
      claim: c.claim,
      status: c.status,
      evidenceIds: c.evidenceIds ?? [],
    })),
    findings: raw.findings ?? [],
    unknowns: raw.unknowns ?? [],
    importantInformation: raw.importantInformation ?? [],
    inputs: raw.inputs ?? [],
    ...(raw.copilotSessionId ? { copilotSessionId: raw.copilotSessionId } : {}),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

export async function investigationExists(name: string): Promise<boolean> {
  try {
    await fs.access(contextFile(name));
    return true;
  } catch {
    for (const legacy of [
      path.join(config.legacyDataDir, 'investigations', name, 'investigation.json'),
      path.join(config.legacyDataDir, 'investigations', name + '.json'),
    ]) {
      try {
        await fs.access(legacy);
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }
}

export async function saveDiscoverySnapshot(name: string, runId: string, snapshot: unknown): Promise<string> {
  const dir = discoveryDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, runId + '.json');
  await fs.writeFile(fp, JSON.stringify(snapshot, null, 2));
  return fp;
}

export async function loadLatestSnapshot<T>(name: string): Promise<T | null> {
  let files: string[];
  try {
    files = (await fs.readdir(discoveryDir(name))).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const last = files[files.length - 1] as string;
  return JSON.parse(await fs.readFile(path.join(discoveryDir(name), last), 'utf-8')) as T;
}