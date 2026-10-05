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

function allKnownEvidence(ids: string[], known: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => known.has(id));
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
      ? '确认时保存的目标、范围、系统与当前值' + (snapshotMatches ? '一致。' : '不一致，需要重新确认。')
      : '没有可比较的确认记录。',
  );

  let sourceValid = false;
  if (validation) {
    const evidenceValid = validation.evidenceIds.length === 0
      ? false
      : allKnownEvidence(validation.evidenceIds, knownEvidence);
    sourceValid = validation.source === 'user'
      ? validation.userConfirmed
      : validation.source === 'materials'
        ? evidenceValid
        : validation.userConfirmed && evidenceValid;
  }
  add(
    '确认来源可以追溯',
    sourceValid,
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

/** 将 Gate 失败转换成人可以直接处理的错误消息。 */
export function formatScopeGateFailure(result: ScopeGateResult): string {
  const failed = result.checks.filter((item) => !item.passed).map((item) => item.name + '：' + item.detail);
  return '这次调查的目标、范围和系统还没有确认完整，暂时不能生成正式结果。'
    + (failed.length ? ' ' + failed.join('；') : '')
    + ' 请回到调查，让助手先从已有材料整理候选，材料说不清时会请你确认。';
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

  const source = intake.source;
  const evidenceIds = [...new Set(intake.evidenceIds)];
  const sourceValid = source === 'user'
    ? intake.userConfirmed
    : source === 'materials'
      ? evidenceIds.length > 0
      : intake.userConfirmed && evidenceIds.length > 0;
  if (!sourceValid) return false;

  inv.goal = goal;
  inv.scope = scope;
  inv.systems = systems;
  inv.scopeValidation = {
    status: 'validated',
    goal,
    scope,
    systems,
    source,
    userConfirmed: intake.userConfirmed,
    evidenceIds,
    validatedAt: new Date().toISOString(),
  };
  await saveInvestigation(inv);
  return true;
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
