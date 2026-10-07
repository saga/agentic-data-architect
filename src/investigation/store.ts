/**
 * Investigation 持久化 Store。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DiscoverySnapshotSchema } from './discovery-snapshot-schema.js';
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
import { JourneyPlanSchema, WorkspaceContextSchema, type JourneyPlan } from './schemas.js';

/** Investigation 是 WorkspaceContext 在业务层的别名，代表持久化的当前分析状态。 */
export type Investigation = WorkspaceContext;

/** 判断两个 Mission 是否代表同一份用户任务；用于防止旧 turn 写回已失效的范围确认。 */
function sameMission(
  left: Investigation['mission'],
  right: Investigation['mission'],
): boolean {
  return left?.purpose === right?.purpose
    && left?.expectedResult === right?.expectedResult;
}

/** 创建一个空的 Investigation 初始状态；不负责写盘。 */
export function newInvestigation(name: string, userPrompt = '', workflow: Investigation['workflow'] = null): Investigation {
  return {
    schemaVersion: 3,
    name,
    userPrompt,
    workflow,
    // 原始输入只作为 Mission 候选，必须经过用户确认后才进入正式执行。
    goal: userPrompt.trim(),
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
      // 创建/迁移 workspace 时使用本次 Investigation 的初始 workflow；真正写入时下面会以最新 current.workflow 为准。
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
      // Workflow 由独立更新 API 管理；这里必须保留 save 前最新值，避免旧 Agent turn 覆盖用户刚切换的路线。
      workflow: current.workflow,
      goal: inv.goal,
      scope: inv.scope,
      systems: inv.systems,
      // Mission 只能通过 confirmInvestigationMission 修改。这里必须保留锁内读到的最新 Mission，
      // 防止旧 Agent turn 在用户修改 Mission 后把旧任务契约写回去。
      ...(current.mission ? { mission: current.mission } : {}),
      // Mission 改变后，旧 turn 带来的 Scope Confirmation 也不能恢复，否则正式结果会引用旧 Mission。
      ...(sameMission(current.mission, inv.mission)
        ? (inv.scopeValidation ? { scopeValidation: inv.scopeValidation } : {})
        : (current.scopeValidation ? { scopeValidation: current.scopeValidation } : {})),
      questions: inv.questions,
      discoveryRuns: inv.discoveryRuns,
      evidence: inv.evidence,
      claims: inv.claims,
      findings: inv.findings,
      unknowns: inv.unknowns,
      importantInformation: inv.importantInformation,
      ...(inv.agentSessionId ? { agentSessionId: inv.agentSessionId } : {}),
      ...(inv.agentSessionRuntime ? { agentSessionRuntime: inv.agentSessionRuntime } : {}),
      ...(typeof inv.agentConfigurationVersion === 'number'
        ? { agentConfigurationVersion: inv.agentConfigurationVersion }
        : {}),
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

/** 读取当前 WorkspaceContext；新 Investigation 只接受当前 Runtime Schema。 */
export async function loadInvestigation(name: string): Promise<Investigation> {
  await ensureWorkspace(name);
  const raw = JSON.parse(await fs.readFile(contextFile(name), 'utf-8')) as unknown;
  return WorkspaceContextSchema.parse(raw);
}

/**
 * 保存并确认本次 Investigation 的 Mission Contract。
 *
 * Mission 改变后，原来的 Scope Confirmation、Agent Session 和动态路线都可能已经过时，
 * 因此一律失效，要求从新的 Mission 重新整理。
 */
export async function confirmInvestigationMission(
  name: string,
  mission: Investigation['mission'],
): Promise<Investigation> {
  if (!mission) throw new Error('Mission 不能为空。');
  if (mission.status !== 'confirmed' || mission.confirmedBy !== 'user') {
    throw new Error('只有用户明确确认的 Mission Contract 才能保存为正式任务。');
  }

  return withWorkspaceContextLock(name, async () => {
    const current = await loadWorkspaceContext(name);
    const missionChanged =
      current.mission?.purpose !== mission.purpose
      || current.mission?.expectedResult !== mission.expectedResult
      || JSON.stringify(current.mission?.deliverables.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        required: item.required,
      }))) !== JSON.stringify(mission.deliverables.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        required: item.required,
      })));

    const next = WorkspaceContextSchema.parse({
      ...current,
      mission,
      // 保留 goal 作为当前 Mission 的任务目的投影；Mission 是正式来源。
      goal: mission.purpose,
      updatedAt: new Date().toISOString(),
    });

    const nextState = { ...next };
    if (missionChanged) {
      // Mission 真正改变后，旧范围确认、Copilot Session 和动态路线都可能已经过时。
      delete nextState.scopeValidation;
      delete nextState.agentSessionId;
      delete nextState.agentSessionRuntime;
      delete nextState.agentConfigurationVersion;
      delete nextState.copilotSessionId;
      delete nextState.copilotConfigurationVersion;
      delete nextState.journeyPlan;
      // Findings / Claims / Unknowns 是针对 Mission 的解释结果，不属于新的 Mission generation。
      // Evidence / Discovery history 保留，供重新调查时复用，但旧结论不得进入新报告。
      nextState.claims = [];
      nextState.findings = [];
      nextState.unknowns = [];
    }

    await writeJsonAtomic(contextFile(name), nextState);
    return nextState;
  });
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
    delete nextState.agentSessionId;
    delete nextState.agentSessionRuntime;
    delete nextState.agentConfigurationVersion;
    delete nextState.copilotSessionId;
    delete nextState.copilotConfigurationVersion;
    // 工作方式换了，上一条 Agent 动态路线也不再可信。
    delete nextState.journeyPlan;

    const next = WorkspaceContextSchema.parse({
      ...nextState,
      workflow,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(contextFile(name), next);
    return next;
  });
}

/** 原子更新最近一次 Agent 动态路线；不会触碰 Evidence、消息和调查事实。 */
export async function updateInvestigationJourneyPlan(
  name: string,
  journeyPlan: JourneyPlan | undefined,
  expectedWorkflow?: Investigation['workflow'],
): Promise<Investigation> {
  return withWorkspaceContextLock(name, async () => {
    const current = await loadWorkspaceContext(name);

    // 如果用户已经在 Agent 执行期间切换了 Workflow，丢弃旧 turn 生成的路线，避免路线地图倒退。
    if (typeof expectedWorkflow !== 'undefined' && current.workflow !== expectedWorkflow) {
      return current;
    }

    const parsed = journeyPlan ? JourneyPlanSchema.parse(journeyPlan) : undefined;
    const nextState = { ...current };
    if (parsed) nextState.journeyPlan = parsed;
    else delete nextState.journeyPlan;

    const next = WorkspaceContextSchema.parse({
      ...nextState,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(contextFile(name), next);
    return next;
  });
}

/** 判断当前 Investigation 是否存在。 */
export async function investigationExists(name: string): Promise<boolean> {
  try {
    await fs.access(contextFile(name));
    return true;
  } catch {
    return false;
  }
}

/** 原子保存一次 Discovery 快照，避免 Agent 读取到半写入 JSON。 */
export async function saveDiscoverySnapshot(name: string, runId: string, snapshot: unknown): Promise<string> {
  const parsed = DiscoverySnapshotSchema.parse(snapshot);
  if (parsed.run.id !== runId) throw new Error('Discovery Snapshot runId 与文件 runId 不一致。');
  if (!parsed.run.scopeFingerprint) throw new Error('Discovery Snapshot 缺少 Scope fingerprint，不能作为新的 current source。');
  const normalized = DiscoverySnapshotSchema.parse({
    ...parsed,
    generation: parsed.generation ?? {
      id: parsed.run.id,
      scopeFingerprint: parsed.run.scopeFingerprint,
    },
  });
  const dir = discoveryDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, runId + '.json');
  await writeJsonAtomic(fp, normalized);
  return fp;
}

export async function loadLatestDiscoverySnapshot(name: string): Promise<import('../workflow/discover.js').DiscoverySnapshot | null> {
  let files: string[];
  try {
    files = (await fs.readdir(discoveryDir(name))).filter((f) => f.endsWith('.json')).sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!files.length) return null;
  const last = files[files.length - 1] as string;
  return DiscoverySnapshotSchema.parse(JSON.parse(await fs.readFile(path.join(discoveryDir(name), last), 'utf-8'))) as import('../workflow/discover.js').DiscoverySnapshot;
}

/** 兼容旧调用入口；Discovery Snapshot 统一经过 Runtime Schema 校验。 */
export async function loadLatestSnapshot<T>(name: string): Promise<T | null> {
  return await loadLatestDiscoverySnapshot(name) as T | null;
}