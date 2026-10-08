import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, type Investigation } from '../investigation/store.js';
import { artifactsDir } from '../investigation/workspace.js';
import { evaluateMissionGate } from './mission-gate.js';
import { evaluateInvestigationScopeGate } from './scope-gate.js';
import { calibrateStatus, type EvidenceRef, type Finding } from '../evidence/types.js';
import { isDiscoverySnapshotCompatible } from '../investigation/artifact-provenance.js';
import { evaluateDerivedState } from './derived-state.js';
import { buildModernizationGaps } from '../analysis/gap.js';
import { loadArchitectureAssessmentPlan } from './assessment.js';
import type { DiscoverySnapshot } from './discover.js';

export interface ReportGateCheck { name: string; passed: boolean; detail: string; }
export interface ReportGateResult { passed: boolean; checks: ReportGateCheck[]; }

export class ReportGateError extends Error {
  readonly result: ReportGateResult;
  constructor(result: ReportGateResult) {
    const failed = result.checks.filter((item) => !item.passed).map((item) => item.detail);
    super('现在还不能生成最终报告。' + (failed.length ? ' ' + failed.join(' ') : ''));
    this.name = 'ReportGateError';
    this.result = result;
  }
}

function allKnown(ids: string[], known: Set<string>): boolean {
  return ids.every((id) => known.has(id));
}

export interface InvestigationReportGateInput {
  mission?: unknown;
  goal: string;
  scope: string[];
  systems: string[];
  scopeValidation?: { status: string; goal: string; scope: string[]; systems: string[]; source: 'user' | 'materials' | 'mixed'; userConfirmed: boolean; evidenceIds: string[]; validatedAt: string; } | undefined;
  evidence: EvidenceRef[];
  /** Scope Gate 需要把引用 Evidence 追溯到产生它的 DiscoveryRun。 */
  discoveryRuns: Investigation['discoveryRuns'];
  claims: Array<{ status: 'verified' | 'supported' | 'inferred' | 'unknown' | 'contradicted'; evidenceIds: string[] }>;
  findings: Finding[];
  resultArtifactCount?: number;
  workflow?: string | null;
  assessmentPlanAvailable?: boolean;
  assessmentRecommendationCount?: number;
  assessmentRoadmapCount?: number;
}

export function evaluateInvestigationReportGate(
  investigation: InvestigationReportGateInput,
  snapshot: DiscoverySnapshot | null,
): ReportGateResult {
  const checks: ReportGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const evidenceIds = new Set(investigation.evidence.map((item) => item.id));

  const missionGate = investigation.mission
    ? evaluateMissionGate(investigation.mission as Parameters<typeof evaluateMissionGate>[0])
    : { passed: false };
  add('任务已经确认', missionGate.passed, missionGate.passed ? '这次报告对应的任务已经确认。' : '还没有确认这次调查为什么做、最后要拿到什么。');

  const scopeGate = evaluateInvestigationScopeGate(
    investigation as Parameters<typeof evaluateInvestigationScopeGate>[0],
    evidenceIds,
  );
  add('调查范围已经确认', scopeGate.passed, scopeGate.passed ? '报告范围已经确认。' : '报告范围还没有完成确认，不能把局部结果当成正式结果。');

  const hasResult = investigation.evidence.length > 0
    || investigation.claims.length > 0
    || investigation.findings.length > 0
    || (investigation.resultArtifactCount ?? 0) > 0;
  add('已经形成真实调查成果', hasResult, hasResult ? '已经保存了可以写入报告的调查成果。' : '目前只有任务说明，还没有形成可交付的调查成果。');

  const hasAnalysisArtifact = (investigation.resultArtifactCount ?? 0) > 0;
  add(
    '已经留下中间分析记录',
    hasAnalysisArtifact,
    hasAnalysisArtifact
      ? '调查过程已经留下可以继续复看的分析记录。'
      : '还没有留下中间分析记录，最终报告不能作为完整调查结果。',
  );

  const invalidClaims = investigation.claims.filter((claim) => {
    if (claim.status === 'unknown') return false;
    if (!allKnown(claim.evidenceIds, evidenceIds)) return true;
    const kept = investigation.evidence.filter((item) => claim.evidenceIds.includes(item.id));
    return calibrateStatus(kept, claim.status) !== claim.status;
  });
  add('结论有足够的资料依据', invalidClaims.length === 0, invalidClaims.length ? '有一些结论的资料依据不足或已经失效。' : '已保存的结论都能回到现有资料。');

  const invalidFindings = investigation.findings.filter((finding) => !allKnown(finding.evidenceIds, evidenceIds));
  add('问题引用的资料有效', invalidFindings.length === 0, invalidFindings.length ? '有一些问题引用了不存在的资料。' : '问题所引用的资料都存在。');

  const snapshotValid = isDiscoverySnapshotCompatible(investigation, snapshot);
  add('发现结果仍属于当前范围', snapshotValid, snapshotValid ? '发现结果与当前调查范围一致。' : '发现结果属于旧的调查范围，需要重新执行发现。');

  const gaps = buildModernizationGaps({
    currentState: snapshot?.currentState ?? null,
    estate: snapshot?.estate,
    findings: investigation.findings,
  });
  const derived = evaluateDerivedState({
    goal: investigation.goal,
    currentState: snapshot?.currentState ?? null,
    estateColumnCount: snapshot?.estate?.nodes.filter((node) => node.type === 'column').length ?? 0,
    sourceOfTruthCandidateCount: snapshot?.currentState?.sourceOfTruthCandidates.length ?? 0,
    lineageEdgeCount: snapshot?.lineage?.edges.length ?? snapshot?.estate?.edges.length ?? 0,
    findingsCount: investigation.findings.length,
    scopeReady: investigation.scopeValidation?.status === 'validated',
    highGapKinds: gaps.filter((gap) => gap.severity === 'high').map((gap) => gap.kind),
    assessment: investigation.workflow === 'data-architecture-assessment'
      ? {
          exists: investigation.assessmentPlanAvailable === true,
          findingsCount: investigation.findings.length,
          recommendationCount: investigation.assessmentRecommendationCount ?? 0,
          roadmapCount: investigation.assessmentRoadmapCount ?? 0,
        }
      : null,
  });

  if (investigation.workflow === 'current-data-architecture') {
    add(
      '当前数据架构已经达到报告所需的事实基础',
      derived.currentDataArchitectureReady,
      derived.currentDataArchitectureReady
        ? '当前数据架构已经形成可阅读的事实基础。'
        : '当前数据架构的关键数据流、数据模型或转换信息仍不完整。',
    );
  }

  if (investigation.workflow === 'data-architecture-assessment') {
    add(
      '评估建立在当前架构事实之上',
      derived.assessmentCurrentStateReady,
      derived.assessmentCurrentStateReady
        ? 'Assessment 建立在当前架构事实基础上。'
        : '当前架构的关键数据流、数据模型或转换信息还不完整，不能形成正式评估。',
    );
    add(
      '数据架构评估结果已经形成',
      derived.assessmentRoadmapReady,
      derived.assessmentRoadmapReady
        ? 'Assessment 结果已经保存。'
        : 'Assessment 结果还没有形成完整的建议与实施顺序。',
    );
  }

  return { passed: checks.every((item) => item.passed), checks };
}

async function countAnalysisArtifacts(name: string): Promise<number> {
  const root = path.join(artifactsDir(name), 'analysis');
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export async function runInvestigationReportGate(
  name: string,
  source?: { investigation: InvestigationReportGateInput; snapshot: DiscoverySnapshot | null },
): Promise<ReportGateResult> {
  if (source) return evaluateInvestigationReportGate(source.investigation, source.snapshot);
  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  const assessment = investigation.workflow === 'data-architecture-assessment'
    ? await loadArchitectureAssessmentPlan(name)
    : null;
  return evaluateInvestigationReportGate(
    {
      ...investigation,
      resultArtifactCount: await countAnalysisArtifacts(name),
      workflow: investigation.workflow,
      assessmentPlanAvailable: Boolean(assessment),
      assessmentRecommendationCount: assessment?.recommendations.length ?? 0,
      assessmentRoadmapCount: assessment?.roadmap.length ?? 0,
    },
    snapshot,
  );
}

export async function assertInvestigationReportGate(
  name: string,
  source?: { investigation: InvestigationReportGateInput; snapshot: DiscoverySnapshot | null },
): Promise<ReportGateResult> {
  const result = await runInvestigationReportGate(name, source);
  if (!result.passed) throw new ReportGateError(result);
  return result;
}