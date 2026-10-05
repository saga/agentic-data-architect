/**
 * Investigation 阶段成果 Script Gate。
 *
 * 阶段小结不能由 Agent 自己说“我已经完成了”来决定。
 * Agent 只负责返回本轮调查结果；是否值得留下一个阶段成果，由这里的确定性规则判断。
 *
 * Gate 的核心原则：
 * 1. 仅凭一段自然语言 answer 永远不能通过；
 * 2. 至少要有 Evidence-backed Claim，或者 Investigation 在本阶段出现真实持久化变化；
 * 3. Claim 引用的 Evidence 必须真实存在；
 * 4. Gate 结果本身可以序列化到 trajectory，脚本可以重新检查，避免运行时和事后判断不一致。
 */
import type { ParsedAnswer } from '../agent/result.js';
import type { AgentCheckpoint } from '../investigation/schemas.js';
import type { Investigation } from '../investigation/store.js';

export interface StageGateSnapshot {
  evidenceIds: string[];
  findingIds: string[];
  discoveryRunCount: number;
  scopeValidatedAt?: string;
}

export interface StageGateInput {
  execution: number;
  before: StageGateSnapshot;
  after: StageGateSnapshot;
  parsed: Pick<ParsedAnswer, 'answer' | 'claims' | 'unknowns' | 'followUpQuestions' | 'routeOptions'>;
}

export interface StageGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface StageGateResult {
  execution: number;
  passed: boolean;
  checks: StageGateCheck[];
  newEvidenceIds: string[];
  newFindingIds: string[];
  evidenceBackedClaimCount: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function newIds(before: string[], after: string[]): string[] {
  const previous = new Set(before);
  return after.filter((id) => !previous.has(id));
}

/** 从 Investigation 状态提取只读快照；快照用于比较本阶段是否产生了真实持久化变化。 */
export function snapshotInvestigationForStageGate(
  investigation: Pick<Investigation, 'evidence' | 'findings' | 'discoveryRuns' | 'scopeValidation'>,
): StageGateSnapshot {
  return {
    evidenceIds: investigation.evidence.map((item) => item.id),
    findingIds: investigation.findings.map((item) => item.id),
    discoveryRunCount: investigation.discoveryRuns.length,
    ...(investigation.scopeValidation?.validatedAt
      ? { scopeValidatedAt: investigation.scopeValidation.validatedAt }
      : {}),
  };
}

/**
 * 确定性判断本阶段是否形成值得留下的阶段成果。
 *
 * 注意：parsed.answer 的文字质量不会决定 Gate 是否通过。
 * answer 写得再漂亮，但没有 Evidence-backed Claim，也没有真实调查状态变化，仍然失败。
 */
export function evaluateInvestigationStageGate(input: StageGateInput): StageGateResult {
  const checks: StageGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  const knownEvidence = new Set(input.after.evidenceIds);
  const invalidClaimEvidence = input.parsed.claims.filter((claim) =>
    claim.evidenceIds.length > 0
    && claim.evidenceIds.some((id) => !knownEvidence.has(id)),
  );

  const evidenceBackedClaims = input.parsed.claims.filter((claim) =>
    claim.evidenceIds.length > 0
    && claim.evidenceIds.every((id) => knownEvidence.has(id)),
  );

  const newEvidenceIds = newIds(input.before.evidenceIds, input.after.evidenceIds);
  const newFindingIds = newIds(input.before.findingIds, input.after.findingIds);
  const newDiscoveryRuns = Math.max(
    0,
    input.after.discoveryRunCount - input.before.discoveryRunCount,
  );
  const scopeValidated = Boolean(
    input.after.scopeValidatedAt
    && input.after.scopeValidatedAt !== input.before.scopeValidatedAt,
  );

  add(
    '阶段回答存在',
    Boolean(input.parsed.answer.trim()),
    input.parsed.answer.trim() ? '已有本阶段回答。' : '本阶段没有可保存的回答。',
  );

  add(
    'Claim 的 Evidence 引用有效',
    invalidClaimEvidence.length === 0,
    invalidClaimEvidence.length
      ? '有 ' + String(invalidClaimEvidence.length) + ' 条 Claim 引用了不存在的 Evidence。'
      : '本阶段 Claim 的 Evidence 引用均有效。',
  );

  add(
    '本阶段存在真实调查成果',
    newEvidenceIds.length > 0
      || newFindingIds.length > 0
      || newDiscoveryRuns > 0
      || scopeValidated,
    [
      '新增 Evidence=' + String(newEvidenceIds.length),
      '新增 Finding=' + String(newFindingIds.length),
      '新增 Discovery=' + String(newDiscoveryRuns),
      '新增范围确认=' + (scopeValidated ? '1' : '0'),
      '有 Evidence 的 Claim=' + String(evidenceBackedClaims.length),
    ].join('，'),
  );

  return {
    execution: input.execution,
    passed: checks.every((item) => item.passed)
      && (
        newEvidenceIds.length > 0
        || newFindingIds.length > 0
        || newDiscoveryRuns > 0
        || scopeValidated
      ),
    checks,
    newEvidenceIds,
    newFindingIds,
    evidenceBackedClaimCount: evidenceBackedClaims.length,
  };
}

/**
 * Gate 通过后生成展示用阶段小结。
 *
 * 这里不会再次判断“是否完成”，只把已经通过 Gate 的本阶段结果整理成 UI 可读的记录。
 * 阶段标题优先使用固定阶段序号，避免 Agent 自己命名成“已完成某阶段”造成误导。
 */
export function buildStageCheckpoint(
  input: StageGateInput,
  gate: StageGateResult,
): AgentCheckpoint {
  if (!gate.passed) {
    throw new Error('Stage Gate 未通过，不能生成阶段小结。');
  }

  const summary = input.parsed.answer
    .split(/\n\s*\n/)
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .find(Boolean)
    ?.slice(0, 500)
    || '这一阶段已经形成可保存的调查结果。';

  const knownEvidence = new Set(input.after.evidenceIds);
  const confirmed = input.parsed.claims
    .filter((claim) =>
      (claim.status === 'supported' || claim.status === 'verified')
      && claim.evidenceIds.length > 0
      && claim.evidenceIds.every((id) => knownEvidence.has(id)),
    )
    .map((claim) => claim.claim.trim())
    .filter(Boolean)
    .slice(0, 6);

  const evidenceIds = unique([
    ...gate.newEvidenceIds,
    ...input.parsed.claims.flatMap((claim) =>
      claim.evidenceIds.filter((id) => knownEvidence.has(id))),
  ]).slice(0, 12);

  const unknowns = input.parsed.unknowns
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);

  return {
    title: '第 ' + String(input.execution + 1) + ' 阶段',
    summary,
    confirmed,
    evidenceIds,
    unknowns,
    ...(input.parsed.followUpQuestions[0]
      ? { nextStep: input.parsed.followUpQuestions[0].trim().slice(0, 500) }
      : input.parsed.routeOptions[0]?.steps[0]
        ? { nextStep: input.parsed.routeOptions[0].steps[0].trim().slice(0, 500) }
        : {}),
  };
}
