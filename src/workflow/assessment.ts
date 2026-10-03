import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import { writeJsonAtomic } from '../investigation/workspace.js';
import { buildModernizationGaps } from '../analysis/gap.js';
import { buildJourneyState, loadWorkflowJourney, type JourneyState } from './journey.js';
import type { DiscoverySnapshot } from './discover.js';

/**
 * 架构评估结果是一个轻量的“可继续讨论的草案”，不是自动审批结论。
 * Investigation / Evidence 仍然是事实来源；这里仅把现有 Findings 组织成稳定输出。
 */
export const ArchitectureAssessmentPlanSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['draft', 'reviewed']),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  goal: z.string(),
  scope: z.array(z.string()),
  currentState: z.object({
    datasets: z.number().int().nonnegative(),
    lineageCoverage: z.number().min(0).max(1).nullable(),
    semanticAssets: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    unknowns: z.number().int().nonnegative(),
  }).strict(),
  findings: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: z.string().min(1),
    description: z.string().min(1),
    recommendation: z.string().min(1),
    evidenceIds: z.array(z.string()),
  }).strict()),
  recommendations: z.array(z.string()),
  roadmap: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    objective: z.string().min(1),
    findingIds: z.array(z.string()),
  }).strict()),
  evidenceIds: z.array(z.string()),
  journey: z.unknown().optional(),
}).strict();
export type ArchitectureAssessmentPlan = z.infer<typeof ArchitectureAssessmentPlanSchema>;

const planFile = (name: string): string => path.join(reportsDir(name), 'architecture-assessment.json');

interface FindingRecommendationRule {
  id: string;
  version: number;
  enabled: boolean;
  type: string;
  recommendation: string;
}

interface FindingRecommendationRulesFile {
  schemaVersion: number;
  rules: FindingRecommendationRule[];
}

/** 从可审查的 JSON 规则表读取 Finding → Recommendation 映射。 */
async function loadFindingRecommendationRules(): Promise<FindingRecommendationRulesFile> {
  const file = path.join(process.cwd(), 'config', 'rules', 'assessment-finding-recommendations.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as FindingRecommendationRulesFile;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.rules)) throw new Error('Finding recommendation rules 配置不正确。');
  return raw;
}

function recommendationForFinding(type: string, rules: FindingRecommendationRule[]): string {
  return rules.find((rule) => rule.enabled && rule.type === type)?.recommendation
    ?? rules.find((rule) => rule.enabled && rule.type === '*')?.recommendation
    ?? '补足证据并确认影响范围，再决定是否需要架构调整。';
}

function dedupe(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

/** 根据当前 Investigation 的事实和 Findings 生成评估草案。 */
export async function buildArchitectureAssessmentPlan(name: string): Promise<{ plan: ArchitectureAssessmentPlan; path: string }> {
  const inv = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  const current = snapshot?.currentState ?? null;
  const gaps = buildModernizationGaps({ currentState: current, estate: snapshot?.estate, findings: inv.findings });
  const timestamp = new Date().toISOString();
  const recommendationRules = (await loadFindingRecommendationRules()).rules;

  const findings = inv.findings.slice(0, 50).map((finding) => ({
    id: finding.id, title: finding.title, severity: finding.severity, description: finding.description,
    recommendation: recommendationForFinding(finding.type, recommendationRules), evidenceIds: finding.evidenceIds,
  }));

  // deterministic gap analyzer 可能先发现问题、但还没有落成 Finding；这里把它标成待确认项。
  for (const gap of gaps.slice(0, 20)) {
    if (findings.some((item) => item.id === gap.id)) continue;
    findings.push({ id: gap.id, title: gap.title, severity: gap.severity, description: gap.description, recommendation: gap.recommendation, evidenceIds: gap.evidenceIds });
  }

  const recommendations = dedupe(findings.map((finding) => finding.recommendation));
  const highFindingIds = findings.filter((finding) => finding.severity === 'high').map((finding) => finding.id);
  const roadmap = [
    { id: 'assessment-roadmap:stabilize', title: '先处理高风险问题', objective: '先处理会阻塞业务、风险控制、数据可信度或后续架构工作的高风险问题。', findingIds: highFindingIds },
    { id: 'assessment-roadmap:standardize', title: '再统一数据和治理基础', objective: '把关键定义、owner、数据质量、lineage、权限和接口规则整理成可以持续维护的机制。', findingIds: findings.map((finding) => finding.id).filter((id) => ['missing_lineage','semantic_conflict','data_quality_issue','identifier_fragmentation'].some((type) => inv.findings.find((item) => item.id === id)?.type === type)) },
    { id: 'assessment-roadmap:target', title: '最后推进目标架构', objective: '在高风险问题和基础治理稳定后，再实施架构重构、平台替换或 AI/Data Product 能力。', findingIds: findings.map((finding) => finding.id) },
  ];

  const plan: ArchitectureAssessmentPlan = ArchitectureAssessmentPlanSchema.parse({
    id: 'assessment-' + Date.now().toString(36),
    title: '架构评估结果', status: 'draft', version: 1, createdAt: timestamp, updatedAt: timestamp,
    goal: inv.goal || inv.userPrompt, scope: inv.scope,
    currentState: { datasets: current?.coverage.datasets ?? 0, lineageCoverage: current?.coverage.datasetLineageCoverage ?? null, semanticAssets: current?.coverage.semanticAssets ?? 0, findings: findings.length, unknowns: inv.unknowns.length },
    findings, recommendations, roadmap, evidenceIds: dedupe(findings.flatMap((finding) => finding.evidenceIds)),
  });
  plan.journey = await buildAssessmentJourneyStateFromPlan(inv, current, plan);
  const outputPath = planFile(name);
  await fs.mkdir(reportsDir(name), { recursive: true });
  await writeJsonAtomic(outputPath, plan);
  return { plan, path: outputPath };
}

/** 读取已经生成的评估结果；读取后仍经过 Zod，不信任磁盘里的 JSON。 */
export async function loadArchitectureAssessmentPlan(name: string): Promise<ArchitectureAssessmentPlan | null> {
  try {
    const raw = JSON.parse(await fs.readFile(planFile(name), 'utf8')) as unknown;
    return ArchitectureAssessmentPlanSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function buildAssessmentJourneyStateFromPlan(inv: Awaited<ReturnType<typeof loadInvestigation>>, current: DiscoverySnapshot['currentState'] | null, plan: ArchitectureAssessmentPlan): Promise<JourneyState> {
  return buildJourneyState(await loadWorkflowJourney('data-architecture-assessment'), {
    goal: inv.goal || inv.userPrompt,
    currentState: current ? { datasets: current.coverage.datasets, lineageCoverage: current.coverage.datasetLineageCoverage, semanticAssets: current.coverage.semanticAssets, parseFailures: current.coverage.sqlParseFailures } : null,
    unknowns: inv.unknowns, highGapKinds: [], targetComponentCount: 0, mappingCount: 0, blockingValidationReady: 0, blockingValidationTotal: 0,
    findingCount: plan.findings.length, recommendationCount: plan.recommendations.length, roadmapItemCount: plan.roadmap.length,
  });
}
