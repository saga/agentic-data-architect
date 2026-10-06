/**
 * Investigation 阶段成果 Script Gate。
 *
 * 阶段小结不能由 Agent 自己说“我已经完成了”来决定。
 * Agent 只负责返回本轮调查结果；是否值得留下一个阶段成果，由这里的确定性规则判断。
 *
 * Gate 的核心原则：
 * 1. 仅凭一段自然语言 answer 永远不能通过；
 * 2. Investigation 必须在本阶段出现真实持久化变化；
 * 3. Claim 引用的 Evidence 必须真实存在；
 * 4. Gate 结果本身可以序列化到 trajectory，脚本可以重新检查，避免运行时和事后判断不一致。
 */
import type { ParsedAnswer } from '../agent/result.js';
import type { AgentCheckpoint, MissionContract } from '../investigation/schemas.js';
import { evaluateMissionGate } from './mission-gate.js';
import type { MissionProgress } from './mission-progress.js';
import type { MissionAlignmentReview } from '../agent/jev-smart-func.js';
import type { Investigation } from '../investigation/store.js';

export interface StageGateSnapshot {
  evidenceIds: string[];
  findingIds: string[];
  discoveryRunCount: number;
  scopeValidatedAt?: string;
}

export interface StageGateInput {
  execution: number;
  mission: MissionContract;
  before: StageGateSnapshot;
  after: StageGateSnapshot;
  missionProgressBefore: MissionProgress;
  missionProgressAfter: MissionProgress;
  parsed: Pick<ParsedAnswer, 'answer' | 'claims' | 'unknowns' | 'followUpQuestions' | 'routeOptions'>;
  /** 本阶段是否已经成功持久化结构化工作成果（例如 Legacy Modernization plan）。 */
  persistedWorkProductChanged?: boolean;
  /** Smart Function 对本阶段成果与 Mission 的语义判断；null 表示语义判断暂时不可用。 */
  missionAlignment?: MissionAlignmentReview | null;
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
  /** 本阶段真正让 Mission 哪些交付物向前推进；这是 Script Gate 的确定性结果。 */
  advancedDeliverables: Array<{ id: string; title: string; from: string; to: string }>;
  evidenceBackedClaimCount: number;
  /** 是否值得继续自动推进；有未覆盖必需交付物时由 Script 强制继续。 */
  shouldContinue: boolean;
  missionAlignment?: MissionAlignmentReview | null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function newIds(before: string[], after: string[]): string[] {
  const previous = new Set(before);
  return after.filter((id) => !previous.has(id));
}

/** 只把交付物状态向前推进视为“本阶段真的帮助了 Mission”。 */
function deliverableAdvanced(
  before: MissionProgress,
  after: MissionProgress,
): Array<{ id: string; title: string; from: string; to: string }> {
  const rank: Record<string, number> = {
    not_started: 0,
    in_progress: 1,
    covered: 2,
    not_tracked: -1,
  };
  return after.deliverables.flatMap((item) => {
    const previous = before.deliverables.find((candidate) => candidate.id === item.id);
    if (!previous || !item.required) return [];
    const from = rank[previous.status] ?? -1;
    const to = rank[item.status] ?? -1;
    return to > from
      ? [{ id: item.id, title: item.title, from: previous.status, to: item.status }]
      : [];
  });
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
 * answer 写得再漂亮，但没有真实调查状态变化，仍然失败。
 */
export function evaluateInvestigationStageGate(input: StageGateInput): StageGateResult {
  const checks: StageGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  const missionGate = evaluateMissionGate(input.mission);
  add(
    'Mission 仍然有效',
    missionGate.passed,
    missionGate.passed
      ? '本阶段仍绑定到已经确认的任务目的和期望结果。'
      : 'Mission 不完整或未确认，不能把本阶段成果算入任务结果。',
  );

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
  const persistedWorkProductChanged = input.persistedWorkProductChanged === true;
  const advancedDeliverables = deliverableAdvanced(
    input.missionProgressBefore,
    input.missionProgressAfter,
  );
  const hasRealStageWork =
    newEvidenceIds.length > 0
    || newFindingIds.length > 0
    || newDiscoveryRuns > 0
    || scopeValidated
    || persistedWorkProductChanged;

  add(
    '阶段回答存在',
    Boolean(input.parsed.answer.trim()),
    input.parsed.answer.trim() ? '已有本阶段回答。' : '本阶段没有可保存的回答。',
  );

  add(
    '阶段成果与 Mission 对齐',
    input.missionAlignment?.aligned ?? true,
    input.missionAlignment
      ? input.missionAlignment.reason
      : 'Smart Function 暂时不可用；本项不单独阻断，继续由确定性结果判断。',
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
    hasRealStageWork,
    [
      '新增 Evidence=' + String(newEvidenceIds.length),
      '新增 Finding=' + String(newFindingIds.length),
      '新增 Discovery=' + String(newDiscoveryRuns),
      '新增范围确认=' + (scopeValidated ? '1' : '0'),
      '结构化成果更新=' + (persistedWorkProductChanged ? '1' : '0'),
      '有 Evidence 的 Claim=' + String(evidenceBackedClaims.length),
    ].join('，'),
  );

  const allRequiredUntracked = input.missionProgressAfter.deliverables.every(
    (item) => !item.required || item.status === 'not_tracked',
  );

  add(
    '本阶段仍然服务于 Mission',
    advancedDeliverables.length > 0 || allRequiredUntracked || hasRealStageWork,
    advancedDeliverables.length
      ? advancedDeliverables.map((item) => item.title + '：' + item.from + ' → ' + item.to).join('，')
      : hasRealStageWork
        ? '本阶段产生了新的可保存成果；是否值得继续由 Mission Completion 决定。'
        : allRequiredUntracked
          ? '本次 Mission 没有可自动量化的交付物，本阶段有真实调查成果即可留下阶段小结。'
          : '本阶段没有新的 Mission 相关成果。',
  );

  const hasOpenRequiredDeliverables = input.missionProgressAfter.deliverables.some(
    (item) => item.required && (item.status === 'not_started' || item.status === 'in_progress'),
  );
  const shouldContinue = hasOpenRequiredDeliverables
    || (input.missionAlignment?.worthContinuing ?? false);

  return {
    execution: input.execution,
    passed: checks.every((item) => item.passed),
    checks,
    newEvidenceIds,
    newFindingIds,
    advancedDeliverables,
    evidenceBackedClaimCount: evidenceBackedClaims.length,
    shouldContinue,
    ...(input.missionAlignment ? { missionAlignment: input.missionAlignment } : {}),
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
      claim.status === 'supported'
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
