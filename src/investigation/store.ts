/**
 * Investigation 持久化 Store。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  contextFile,
  discoveryDir,
  loadWorkspaceContext,
  ensureWorkspace,
  workspaceRoot,
  withWorkspaceContextLock,
  writeJsonAtomic,
  type WorkspaceContext,
} from './workspace.js';
import { migrateLegacyConversationInputs } from './conversation.js';
import { WorkspaceContextSchema } from './schemas.js';

/** Investigation 是 WorkspaceContext 在业务层的别名，代表持久化的当前分析状态。 */
export type Investigation = WorkspaceContext;

/** 创建一个空的 Investigation 初始状态；不负责写盘。 */
export function newInvestigation(name: string, userPrompt = '', workflow: Investigation['workflow'] = null): Investigation {
  return {
    schemaVersion: 3,
    name,
    userPrompt,
    workflow,
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

/** 返回 Investigation 的工作目录。 */
export function investigationRoot(name: string): string {
  return workspaceRoot(name);
}

/** 返回 Investigation context.json 路径。 */
export function investigationFile(name: string): string {
  return contextFile(name);
}

/** 返回当前 Investigation 的报告目录。 */
export function reportsDir(name: string): string {
  return path.join(investigationRoot(name), 'reports');
}

/** 在会话锁内把业务状态合并回最新 WorkspaceContext，再原子写入 context.json。 */
export async function saveInvestigation(inv: Investigation): Promise<string> {
  return withWorkspaceContextLock(inv.name, async () => {
    await ensureWorkspace(inv.name, {
      userPrompt: inv.userPrompt,
      workflow: inv.workflow,
      goal: inv.goal,
      scope: inv.scope,
      systems: inv.systems,
    });

    // Merge investigation-owned state into the latest workspace snapshot.
    // Inputs/files may have been added while the agent was thinking; never
    // overwrite those newer workspace inputs with an older in-memory snapshot.
    const current = await loadWorkspaceContext(inv.name);
    const next: Investigation = {
      ...current,
      schemaVersion: 3,
      name: inv.name,
      userPrompt: inv.userPrompt,
      workflow: inv.workflow,
      goal: inv.goal,
      scope: inv.scope,
      systems: inv.systems,
      questions: inv.questions,
      discoveryRuns: inv.discoveryRuns,
      evidence: inv.evidence,
      claims: inv.claims,
      findings: inv.findings,
      unknowns: inv.unknowns,
      importantInformation: inv.importantInformation,
      ...(inv.copilotSessionId ? { copilotSessionId: inv.copilotSessionId } : {}),
      ...(typeof inv.copilotConfigurationVersion === 'number'
        ? { copilotConfigurationVersion: inv.copilotConfigurationVersion }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(contextFile(inv.name), next);
    return contextFile(inv.name);
  });
}

/** 从当前 workspace 或旧版数据目录读取 Investigation，并执行必要的历史迁移。 */
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

/** 修改当前 Investigation 的工作路线；不改变 Evidence、消息或其它调查状态。 */
export async function updateInvestigationWorkflow(
  name: string,
  workflow: Investigation['workflow'],
): Promise<Investigation> {
  return withWorkspaceContextLock(name, async () => {
    const current = await loadWorkspaceContext(name);
    if (current.workflow === workflow) return current;

    const nextState = { ...current };
    delete nextState.copilotSessionId;
    delete nextState.copilotConfigurationVersion;

    const next = WorkspaceContextSchema.parse({
      ...nextState,
      workflow,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(contextFile(name), next);
    return next;
  });
}

/** 把旧版/不完整 context 转成当前 schemaVersion=3 的可信 Investigation。 */

function normalizeInvestigation(name: string, raw: Partial<Investigation>): Investigation {
  return WorkspaceContextSchema.parse({
    schemaVersion: 3,
    name,
    userPrompt: raw.userPrompt ?? raw.goal ?? '',
    // 旧版本如果没有 workflow，继续按 Legacy Modernization 兼容读取；新建 Investigation 明确使用 null。
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
  });
}

/** 判断当前或旧版存储中是否存在指定 Investigation。 */
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

/** 原子保存一次 Discovery 快照，避免 Agent 读取到半写入 JSON。 */
export async function saveDiscoverySnapshot(name: string, runId: string, snapshot: unknown): Promise<string> {
  const dir = discoveryDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, runId + '.json');
  // Discovery snapshots are later used as agent evidence, so never leave a
  // partially written JSON file behind.
  await writeJsonAtomic(fp, snapshot);
  return fp;
}

/** 按 run 文件名排序读取最近一次 Discovery 快照。 */
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