/**
 * Mission Gate：Investigation 开始前的任务契约检查。
 *
 * 这个 Gate 不判断“这个目标好不好”，只判断：
 * - 有没有明确的任务目的；
 * - 有没有明确的期望结果；
 * - Mission 是否已经由用户确认；
 * - 是否已经拆出至少一个可观察的交付物。
 *
 * 最重要的规则：模型不能代替用户确认 Mission。
 */
import type { MissionContract, MissionDraft } from '../investigation/schemas.js';

export interface MissionGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MissionGateResult {
  passed: boolean;
  checks: MissionGateCheck[];
  draft: MissionDraft;
}

export class MissionGateError extends Error {
  constructor(readonly result: MissionGateResult) {
    super(formatMissionGateFailure(result));
    this.name = 'MissionGateError';
  }
}


export const MISSION_DELIVERABLE_CATALOG = {
  'current-state-architecture': ['当前架构', '梳理当前系统的数据架构、主要组件、数据关系和依赖。'],
  'data-source': ['Data Source', '说明关键数据从哪里来，以及可信来源候选。'],
  'data-flow': ['Data Flow', '说明关键数据如何在系统、数据集和处理环节之间流动。'],
  'data-model': ['Data Model', '说明核心实体、表/视图、字段和主要关系。'],
  'transformation': ['Transformation', '说明影响业务结果的 SQL、ETL、计算和转换。'],
  'target-architecture': ['目标架构', '形成新的数据/应用架构方案及关键设计。'],
  'mapping': ['新旧对应', '说明旧数据、旧能力与新方案之间的对应和转换。'],
  'validation': ['验证', '形成新旧结果、数据质量或业务结果的验证方案/结果。'],
  'findings': ['主要问题', '明确影响当前架构或业务目标的问题、风险和缺口。'],
  'recommendations': ['改进建议', '针对已确认的问题给出改进建议。'],
  'roadmap': ['实施路线', '给出依赖、优先级和实施顺序。'],
  'custom-result': ['其他结果', '按照用户明确说明的期望结果形成最终交付物。'],
} as const;

export type MissionDeliverableId = keyof typeof MISSION_DELIVERABLE_CATALOG;

const KEYWORD_RULES: Array<{ id: MissionDeliverableId; keywords: string[] }> = [
  { id: 'current-state-architecture', keywords: ['当前架构', '现状架构', '现有系统', 'current state', 'current-state'] },
  { id: 'data-source', keywords: ['data source', '数据源', '数据来源', 'source of truth', '权威来源'] },
  { id: 'data-flow', keywords: ['data flow', '数据流', '数据流向', '数据链路', '血缘', 'lineage'] },
  { id: 'data-model', keywords: ['data model', '数据模型', '实体', '表结构', '模型', '关系模型'] },
  { id: 'transformation', keywords: ['transformation', '转换', 'etl', 'sql', '计算逻辑', '加工'] },
  { id: 'target-architecture', keywords: ['target architecture', '目标架构', '新架构', 'replatform', '现代化', '迁移方案', '方案'] },
  { id: 'mapping', keywords: ['mapping', '映射', '新旧对应', '迁移映射'] },
  { id: 'validation', keywords: ['validation', '验证', '对账', 'reconciliation', '一致性检查'] },
  { id: 'findings', keywords: ['问题', '风险', '缺口', 'findings', 'issue'] },
  { id: 'recommendations', keywords: ['建议', '改进', 'recommendation'] },
  { id: 'roadmap', keywords: ['路线', '实施顺序', 'roadmap', '落地计划'] },
];

/** 根据用户已经写出的目的和期望结果做保守的确定性交付物拆分。 */
export function inferMissionDeliverables(
  purpose: string,
  expectedResult: string,
): MissionContract['deliverables'] {
  const corpus = (purpose + '\n' + expectedResult).toLowerCase();
  const matched = KEYWORD_RULES
    .filter((rule) => rule.keywords.some((keyword) => corpus.includes(keyword.toLowerCase())))
    .map((rule) => rule.id);

  const ids = matched.length ? [...new Set(matched)] : ['custom-result' as MissionDeliverableId];

  return ids.slice(0, 12).map((id) => {
    const [title, description] = MISSION_DELIVERABLE_CATALOG[id];
    return {
      id,
      title,
      description,
      required: true,
    };
  });
}

/** 从现有 Investigation 生成待用户确认的 Mission 草稿；这里只做候选，不视为确认。 */
export function buildMissionDraft(
  purposeCandidate: string,
  expectedResultCandidate = '',
): MissionDraft {
  const purpose = purposeCandidate.trim();
  const expectedResult = expectedResultCandidate.trim();
  return {
    purpose,
    expectedResult,
    deliverableIds: expectedResult
      ? inferMissionDeliverables(purpose, expectedResult).map((item) => item.id)
      : [],
  };
}

/** 对已持久化 Mission 执行确定性检查。 */
export function evaluateMissionGate(mission: MissionContract | undefined): MissionGateResult {
  const draft = mission
    ? buildMissionDraft(mission.purpose, mission.expectedResult)
    : { purpose: '', expectedResult: '', deliverableIds: [] };

  const checks: MissionGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail });

  add(
    '任务目的明确',
    Boolean(mission?.purpose.trim()),
    mission?.purpose.trim() ? '已经记录任务目的。' : '还没有记录任务目的。',
  );
  add(
    '期望结果明确',
    Boolean(mission?.expectedResult.trim()),
    mission?.expectedResult.trim() ? '已经记录期望结果。' : '还没有记录期望结果。',
  );
  add(
    '交付物已拆分',
    Boolean(mission?.deliverables.length),
    mission?.deliverables.length
      ? '已经拆成 ' + String(mission.deliverables.length) + ' 项交付物。'
      : '还没有可观察的交付物。',
  );
  add(
    '已由用户确认',
    mission?.status === 'confirmed' && mission.confirmedBy === 'user',
    mission?.status === 'confirmed' && mission.confirmedBy === 'user'
      ? '任务契约已经由用户确认。'
      : '这组任务目的和期望结果还没有经过用户确认。',
  );

  return {
    passed: checks.every((item) => item.passed),
    checks,
    draft,
  };
}

/** 只有完整且明确标记为用户确认的 Mission 才允许 Agent 开始调查。 */
export function assertMissionGate(mission: MissionContract | undefined): MissionContract {
  const result = evaluateMissionGate(mission);
  if (!result.passed) {
    throw new MissionGateError(result);
  }
  return mission!;
}

/** 转成用户可以直接理解的提示；不暴露内部 Gate 字段。 */
export function formatMissionGateFailure(result: MissionGateResult): string {
  const purposeMissing = result.checks.some((item) => item.name === '任务目的明确' && !item.passed);
  const expectedMissing = result.checks.some((item) => item.name === '期望结果明确' && !item.passed);

  if (purposeMissing && expectedMissing) {
    return '开始调查前，需要先确认两件事：为什么要做这次调查，以及最后希望拿到什么结果。';
  }
  if (purposeMissing) {
    return '开始调查前，还需要确认这次调查为什么要做。';
  }
  if (expectedMissing) {
    return '开始调查前，还需要确认最后希望拿到什么结果。';
  }
  return '开始调查前，请先确认这次任务的目的和期望结果。';
}
