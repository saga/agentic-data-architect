import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { Claim, DiscoveryRun, EvidenceRef, Finding } from '../evidence/types.js';
import { ensureWorkspace } from './workspace.js';

/**
 * Investigation 是 Agent 的工作状态（不是 chat session）。
 * 目录布局：
 *   .data/investigations/<name>/
 *     investigation.json   业务状态的唯一真相
 *     discovery/<runId>.json  每次 discover 的快照
 *     reports/report.md    当前报告
 *     workspace/           Agent / research 的实际工作目录
 *       context.json      用户 prompt + 每次 input + 重要信息
 *       research/{github,leanix,confluence,web}/
 *       findings/
 *       artifacts/
 *       notes/
 */

export interface Investigation {
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
  updatedAt: string;
}

export function newInvestigation(name: string, userPrompt = ''): Investigation {
  return {
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
    updatedAt: new Date().toISOString(),
  };
}

export function investigationRoot(name: string): string {
  return path.join(config.investigationDir, name);
}

export function investigationFile(name: string): string {
  return path.join(investigationRoot(name), 'investigation.json');
}

export function discoveryDir(name: string): string {
  return path.join(investigationRoot(name), 'discovery');
}

export function reportsDir(name: string): string {
  return path.join(investigationRoot(name), 'reports');
}

export async function saveInvestigation(inv: Investigation): Promise<string> {
  inv.updatedAt = new Date().toISOString();
  await fs.mkdir(investigationRoot(inv.name), { recursive: true });
  const fp = investigationFile(inv.name);
  await fs.writeFile(fp, JSON.stringify(inv, null, 2));
  await ensureWorkspace(inv.name, {
    userPrompt: inv.userPrompt,
    goal: inv.goal,
    scope: inv.scope,
    systems: inv.systems,
  });
  return fp;
}

export async function loadInvestigation(name: string): Promise<Investigation> {
  try {
    const raw = await fs.readFile(investigationFile(name), 'utf-8');
    const inv = JSON.parse(raw) as Partial<Investigation>;
    const normalized = newInvestigation(name, inv.userPrompt ?? '');
    Object.assign(normalized, inv);
    await ensureWorkspace(normalized.name, {
      userPrompt: normalized.userPrompt,
      goal: normalized.goal,
      scope: normalized.scope,
      systems: normalized.systems,
    });
    return normalized;
  } catch (e) {
    if (!(e instanceof Error) || !('code' in e) || (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 兼容 V1.0 扁平布局（demo.json），读到就地迁移。
  const legacy = path.join(config.investigationDir, `${name}.json`);
  const raw = JSON.parse(await fs.readFile(legacy, 'utf-8')) as Partial<Investigation> & {
    claims?: { claim: string; status: Claim['status']; evidence: unknown[] }[];
  };
  const inv = newInvestigation(name, raw.userPrompt ?? raw.goal ?? '');
  inv.goal = raw.goal ?? '';
  inv.scope = raw.scope ?? [];
  inv.systems = raw.systems ?? [];
  inv.unknowns = raw.unknowns ?? [];
  for (const c of raw.claims ?? []) {
    inv.claims.push({ id: `legacy-${inv.claims.length}`, claim: c.claim, status: c.status, evidenceIds: [] });
  }
  await saveInvestigation(inv);
  return inv;
}

export async function investigationExists(name: string): Promise<boolean> {
  try {
    await fs.access(investigationFile(name));
    return true;
  } catch {
    try {
      await fs.access(path.join(config.investigationDir, `${name}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

export async function saveDiscoverySnapshot(name: string, runId: string, snapshot: unknown): Promise<string> {
  const dir = discoveryDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `${runId}.json`);
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
