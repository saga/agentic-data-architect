/**
 * Investigation 范围的确定性 Gate。
 *
 * 报告、阶段成果和 Workflow 都不能只因为 Agent 说“范围明确了”就继续。
 * 这里检查三件最基本的事情：
 * 1. Goal / Scope / Systems 都真实存在；
 * 2. 没有使用占位符；
 * 3. 已保存的 ScopeValidation 仍然与当前字段一致，并且来源可以追溯到用户或真实 Evidence。
 */
import { loadInvestigation, saveInvestigation, type Investigation } from '../investigation/store.js';
import { computeScopeFingerprint } from '../investigation/artifact-provenance.js';
import type { AgentIntake } from '../investigation/schemas.js';

export interface ScopeGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScopeGateResult {
  passed: boolean;
  checks: ScopeGateCheck[];
}

/** 报告/阶段产物因 Scope 未通过而拒绝生成时使用的明确错误类型。 */
export class ScopeGateError extends Error {
  constructor(public readonly result: ScopeGateResult) {
    super(formatScopeGateFailure(result));
    this.name = 'ScopeGateError';
  }
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function normalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameValues(a: string[], b: string[]): boolean {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

function hasPlaceholder(value: string): boolean {
  return /^(?:\(unset\)|（unset）|\(not set\)|（未设置）|未设置|未知)$/i.test(value.trim());
}

/**
 * 判断本次 Investigation 是否明确限制在 Current-State，暂不进入目标架构/迁移设计。
 * 这是对用户显式范围的保护，不根据任务名称自行推断。
 */
export function isCurrentStateOnlyScope(goal: string, scope: string[]): boolean {
  const text = [goal, ...scope].filter(Boolean).join(' ');
  return /只分析(?:当前)?状态|只做现状|不设计目标架构|不制定迁移计划|不做迁移计划|不设计迁移步骤|不做新旧映射|不做映射/i.test(text);
}

function allKnownEvidence(ids: string[], known: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => known.has(id));
}

/**
 * Material-backed Scope Validation 不能只验证“Evidence ID 存在”。
 * Evidence 可能来自更早的一次 Scope；如果换过范围，旧 Evidence 不能拿来确认新范围。
 * 新的正式 DiscoveryRun 必须带 scopeFingerprint，这里要求它与当前范围一致。
 */
function allEvidenceBelongToScope(
  investigation: Pick<Investigation, 'scope' | 'systems' | 'evidence' | 'discoveryRuns'>,
  ids: string[],
): boolean {
  if (!ids.length) return false;
  const fingerprint = computeScopeFingerprint(investigation);
  const evidenceById = new Map(investigation.evidence.map((item) => [item.id, item]));
  const runById = new Map(investigation.discoveryRuns.map((run) => [run.id, run]));
  return ids.every((id) => {
    const evidence = evidenceById.get(id);
    const run = evidence ? runById.get(evidence.discoveryRunId) : undefined;
    return Boolean(
      evidence
      && run?.scopeFingerprint
      && run.scopeFingerprint === fingerprint,
    );
  });
}

/** 纯函数 Gate，方便测试，也方便报告与 Workflow 共用同一规则。 */
export function evaluateInvestigationScopeGate(
  investigation: Pick<Investigation, 'goal' | 'scope' | 'systems' | 'scopeValidation'>,
  knownEvidence: Set<string>,
): ScopeGateResult {
  const checks: ScopeGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  const goal = investigation.goal.trim();
  const scope = normalized(investigation.scope);
  const systems = normalized(investigation.systems);

  add(
    'Goal / Scope / Systems 都已填写',
    nonEmpty(goal) && scope.length > 0 && systems.length > 0,
    'goal=' + (nonEmpty(goal) ? '已填写' : '缺少')
      + ', scope=' + String(scope.length)
      + ', systems=' + String(systems.length),
  );

  const placeholders = [
    goal,
    ...scope,
    ...systems,
  ].filter(hasPlaceholder);
  add(
    '没有占位内容',
    placeholders.length === 0,
    placeholders.length ? '发现占位内容：' + placeholders.join('、') : '没有发现占位内容。',
  );

  const validation = investigation.scopeValidation;
  add(
    '范围已经明确记录为已确认',
    Boolean(validation && validation.status === 'validated'),
    validation ? '状态=' + validation.status : '还没有范围确认记录。',
  );

  const snapshotMatches = Boolean(
    validation
    && validation.goal === goal
    && sameValues(validation.scope, scope)
    && sameValues(validation.systems, systems),
  );
  add(
    '已确认内容与当前范围一致',
    snapshotMatches,
    validation
      ? '确认时保存的目标、范围、系统和 Scope identity 与当前值' + (snapshotMatches ? '一致。' : '不一致，需要重新确认。')
      : '没有可比较的确认记录。',
  );

  let sourceValid = false;
  if (validation) {
    const evidenceValid = validation.evidenceIds.length === 0
      ? false
      : allKnownEvidence(validation.evidenceIds, knownEvidence)
        && allEvidenceBelongToScope(investigation as Investigation & {
          evidence: Investigation['evidence'];
          discoveryRuns: Investigation['discoveryRuns'];
        }, validation.evidenceIds);
    sourceValid = validation.source === 'user'
      ? validation.userConfirmed
      : validation.source === 'materials'
        ? evidenceValid
        : validation.userConfirmed && evidenceValid;
  }
  const validationDateValid = Boolean(validation && Number.isFinite(Date.parse(validation.validatedAt)));
  add(
    '确认时间有效',
    validationDateValid,
    validation ? 'validatedAt=' + validation.validatedAt : '没有确认记录。',
  );

  add(
    '确认来源可以追溯',
    sourceValid && validationDateValid,
    validation
      ? validation.source === 'user'
        ? (validation.userConfirmed ? '用户已确认。' : '记录不是用户确认。')
        : validation.source === 'materials'
          ? '材料 Evidence ' + (allKnownEvidence(validation.evidenceIds, knownEvidence) ? '有效。' : '无效或已缺失。')
          : (validation.userConfirmed && allKnownEvidence(validation.evidenceIds, knownEvidence)
            ? '用户确认和材料 Evidence 都有效。'
            : '用户确认或材料 Evidence 不完整。')
      : '没有确认记录。',
  );

  return { passed: checks.every((item) => item.passed), checks };
}

/** 将 Gate 失败转换成人可以直接处理的错误消息；不要把内部检查项和机器字段原样堆给用户。 */
export function formatScopeGateFailure(result: ScopeGateResult): string {
  const checks = new Map(result.checks.map((item) => [item.name, item]));
  const failed = (name: string) => checks.get(name)?.passed === false;

  let reason = '范围确认还缺少必要信息。';
  if (failed('Goal / Scope / Systems 都已填写')) {
    reason = '目标、范围或涉及系统还没有补齐。';
  } else if (failed('没有占位内容')) {
    reason = '目标、范围或涉及系统里还有未明确的占位内容。';
  } else if (failed('范围已经明确记录为已确认')) {
    reason = '目标、范围和涉及系统已经整理出来，但还没有完成确认。';
  } else if (failed('已确认内容与当前范围一致')) {
    reason = '已经确认的范围和现在的范围不一致，需要重新确认。';
  } else if (failed('确认时间有效')) {
    reason = '范围确认记录不完整，需要重新确认。';
  } else if (failed('确认来源可以追溯')) {
    reason = '范围虽然标记为已确认，但确认来源不足，暂时不能作为正式结果依据。';
  }

  return '这次调查还不能生成正式结果。'
    + reason
    + ' 请回到调查，让助手先整理已有材料。材料足够明确时会直接确认，存在歧义时再请你确认。';
}

/**
 * Agent 返回结构化 intake 后，只有“完整 + 可追溯”才写入正式调查状态。
 * 未确认的候选不覆盖旧的正式范围，避免把模型猜测当成事实。
 */
export async function persistAgentIntake(
  name: string,
  intake: AgentIntake,
): Promise<boolean> {
  const inv = await loadInvestigation(name);
  const goal = (intake.goal ?? inv.goal ?? inv.userPrompt).trim();
  const scope = normalized(intake.scope ?? inv.scope);
  const systems = normalized(intake.systems ?? inv.systems);

  if (!goal || !scope.length || !systems.length) return false;
  if ([goal, ...scope, ...systems].some(hasPlaceholder)) return false;

  const source = intake.source;
  const evidenceIds = [...new Set(intake.evidenceIds)];
  const sourceValid = source === 'user'
    ? intake.userConfirmed
    : source === 'materials'
      ? allEvidenceBelongToScope(
          { ...inv, scope, systems },
          evidenceIds,
        )
      : intake.userConfirmed && allEvidenceBelongToScope(
          { ...inv, scope, systems },
          evidenceIds,
        );
  if (!sourceValid) return false;

  const changed =
    inv.goal !== goal
    || JSON.stringify(normalized(inv.scope)) !== JSON.stringify(scope)
    || JSON.stringify(normalized(inv.systems)) !== JSON.stringify(systems);

  inv.goal = goal;
  inv.scope = scope;
  inv.systems = systems;
  if (changed) {
    // 范围一旦变化，旧 Runtime Session 里携带的上下文也不再可信。
    // 只清 Copilot 字段是不够的：CodeBuddy / OpenCode 使用统一 agentSessionId。
    inv.claims = [];
    inv.findings = [];
    inv.unknowns = [];
    delete inv.journeyPlan;
    delete inv.agentSessionId;
    delete inv.agentSessionRuntime;
    delete inv.agentConfigurationVersion;
    delete inv.copilotSessionId;
    delete inv.copilotConfigurationVersion;
  }
  inv.scopeValidation = {
    status: 'validated',
    goal,
    scope,
    systems,
    source,
    userConfirmed: intake.userConfirmed,
    evidenceIds,
    scopeFingerprint: computeScopeFingerprint({ scope, systems }),
    validatedAt: new Date().toISOString(),
  };
  await saveInvestigation(inv);
  return true;
}

/** 用户在 init 时已经明确提供完整 Goal / Scope / Systems；无需再伪造一次 ask_user。 */
export function createUserScopeValidation(
  goal: string,
  scope: string[],
  systems: string[],
) {
  const cleanGoal = goal.trim();
  const cleanScope = normalized(scope);
  const cleanSystems = normalized(systems);
  if (!cleanGoal || !cleanScope.length || !cleanSystems.length) return undefined;
  return {
    status: 'validated' as const,
    goal: cleanGoal,
    scope: cleanScope,
    systems: cleanSystems,
    source: 'user' as const,
    userConfirmed: true,
    evidenceIds: [],
    scopeFingerprint: computeScopeFingerprint({ scope: cleanScope, systems: cleanSystems }),
    validatedAt: new Date().toISOString(),
  };
}

/** 对当前 Investigation 执行 Gate。 */
export async function runInvestigationScopeGate(name: string): Promise<ScopeGateResult> {
  const inv = await loadInvestigation(name);
  return evaluateInvestigationScopeGate(
    inv,
    new Set(inv.evidence.map((item) => item.id)),
  );
}

/** Gate 失败时抛出统一错误，供 CLI、Workflow 和报告复用。 */
export async function assertInvestigationScopeGate(name: string): Promise<ScopeGateResult> {
  const result = await runInvestigationScopeGate(name);
  if (!result.passed) throw new ScopeGateError(result);
  return result;
}
