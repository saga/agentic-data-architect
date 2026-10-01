/**
 * Legacy Modernization 主工作流。
 *
 * 这不是另一个 Agent framework；它只是把已有 Discovery / Current-State 结果
 * 组织成 Data Analyst + Data Architect 可以继续编辑、审核和交付的工作包。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import { ModernizationPlanSchema, type AnalysisCase, type ArchitectureDecision, type ModernizationPlan, type TargetArchitecture } from '../model/modernization.js';
import type { DiscoverySnapshot } from './discover.js';
import { buildModernizationGaps } from '../analysis/gap.js';

function productId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** 生成最小的 Analyst Case，让后续 UI/Agent 有一个明确的分析载体。 */
function buildInitialAnalysisCase(goal: string, scope: string[], evidenceIds: string[]): AnalysisCase {
  const timestamp = now();
  return {
    id: productId('analysis'),
    type: 'analysis_case',
    title: goal || 'Legacy modernization analysis',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds,
    findingIds: [],
    decisionIds: [],
    question: goal || '这个 legacy data estate 当前是如何工作的？哪些部分需要优先现代化？',
    scope,
    hypotheses: [],
    steps: [
      {
        id: productId('step'),
        title: 'Establish current state',
        action: 'Review current-state coverage, lineage, semantic context and findings before proposing target changes.',
        status: 'planned',
        evidenceIds,
      },
      {
        id: productId('step'),
        title: 'Identify modernization gaps',
        action: 'Resolve the high-impact gaps that affect source-of-truth, business semantics, lineage and migration scope.',
        status: 'planned',
        evidenceIds,
      },
    ],
  };
}

/** 先提供一个厂商无关的 target blueprint，明确它仍是 draft，不冒充最终架构。 */
function buildTargetArchitecture(goal: string, gaps: ReturnType<typeof buildModernizationGaps>): TargetArchitecture {
  const timestamp = now();
  const gapIds = gaps.map((g) => g.id);
  return {
    id: productId('target'),
    type: 'target_architecture',
    title: 'Draft Target Architecture',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds: gaps.flatMap((g) => g.evidenceIds),
    findingIds: gaps.filter((g) => g.kind === 'data_quality' || g.kind === 'architecture').map((g) => g.id),
    decisionIds: [],
    principles: [
      'Business meaning should be explicit and traceable to approved semantic context.',
      'Physical storage and transformation technology should remain replaceable.',
      'Source-of-truth, lineage and data-quality controls must be explicit before cutover.',
      'Target design is a reviewed work product, not an Agent-generated fact.',
    ],
    components: [
      {
        id: 'target:source',
        type: 'source',
        name: 'Legacy / External Sources',
        description: 'Existing databases, files, vendor feeds, APIs and applications that remain in scope.',
        dependsOn: [],
        sourceAssets: [],
      },
      {
        id: 'target:ingestion',
        type: 'ingestion',
        name: 'Managed Ingestion',
        description: 'Target ingestion boundary with explicit contracts, freshness and failure handling.',
        dependsOn: ['target:source'],
        sourceAssets: [],
      },
      {
        id: 'target:domain-data',
        type: 'domain_data',
        name: 'Domain Data Products / Curated Data',
        description: 'Business-oriented datasets with explicit ownership and source-of-truth rules.',
        dependsOn: ['target:ingestion'],
        sourceAssets: [],
      },
      {
        id: 'target:transformation',
        type: 'transformation',
        name: 'Business Transformations',
        description: 'Transformations separated from ingestion so business logic can be tested and migrated independently.',
        dependsOn: ['target:domain-data'],
        sourceAssets: [],
      },
      {
        id: 'target:semantic',
        type: 'semantic',
        name: 'Business / Semantic Layer',
        description: 'Provider-neutral semantic context; Snowflake Semantic View or Data Product can be one implementation.',
        dependsOn: ['target:domain-data', 'target:transformation'],
        sourceAssets: [],
      },
      {
        id: 'target:serving',
        type: 'serving',
        name: 'Analytics / Applications',
        description: 'Reports, dashboards, research, APIs and downstream applications consuming governed data.',
        dependsOn: ['target:semantic'],
        sourceAssets: [],
      },
      {
        id: 'target:governance',
        type: 'governance',
        name: 'Quality / Lineage / Access / Audit',
        description: 'Cross-cutting controls required to validate and operate the modernized estate.',
        dependsOn: ['target:ingestion', 'target:domain-data', 'target:semantic', 'target:serving'],
        sourceAssets: [],
      },
    ],
    openQuestions: [
      goal ? `What business outcomes and scope boundaries must the target architecture preserve for: ${goal}` : 'What business outcomes and scope boundaries must the target architecture preserve?',
      ...gapIds.map((id) => `Resolve modernization gap ${id}`),
    ],
  };
}

/** 建立默认 ADR 容器；真正的设计决定由 Agent + Human Review 填充。 */
function buildInitialDecisions(): ArchitectureDecision[] {
  const timestamp = now();
  return [{
    id: productId('decision'),
    type: 'architecture_decision',
    title: 'Keep semantic context provider-neutral',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds: [],
    findingIds: [],
    decisionIds: [],
    context: 'The modernization workbench needs to understand business meaning without making the core model dependent on one platform.',
    options: [
      'Make Snowflake the core semantic model',
      'Use a provider-neutral semantic asset contract',
    ],
    decision: 'Use a provider-neutral semantic asset contract.',
    rationale: 'Snowflake can be a major source through Semantic Views and Data Products, while other catalogs and business definitions remain pluggable.',
    tradeoffs: [
      'Requires adapters/providers for each semantic source.',
      'Provider-specific features may need to remain in asset attributes until they can be normalized.',
    ],
  }];
}

/** 生成并持久化 modernization plan，供 UI、CLI 和后续 Agent 继续编辑。 */
export async function buildModernizationPlan(name: string): Promise<{ plan: ModernizationPlan; path: string }> {
  const inv = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  const current = snapshot?.currentState ?? null;
  const gaps = buildModernizationGaps({
    currentState: current,
    estate: snapshot?.estate,
    findings: inv.findings,
  });
  const evidenceIds = [
    ...inv.evidence.map((e) => e.id),
    ...gaps.flatMap((g) => g.evidenceIds),
  ].filter((id, index, ids) => ids.indexOf(id) === index);

  const analysisCase = buildInitialAnalysisCase(inv.goal || inv.userPrompt, inv.scope, evidenceIds.slice(0, 100));
  const targetArchitecture = buildTargetArchitecture(inv.goal || inv.userPrompt, gaps);
  const decisions = buildInitialDecisions();
  const plan: ModernizationPlan = ModernizationPlanSchema.parse({
    id: productId('modernization'),
    title: inv.goal || 'Legacy Modernization Plan',
    status: 'draft',
    version: 1,
    generatedAt: now(),
    goal: inv.goal,
    scope: inv.scope,
    currentState: {
      datasets: current?.coverage.datasets ?? snapshot?.lineage?.tables.filter((t) => !t.startsWith('file:')).length ?? 0,
      lineageCoverage: current?.coverage.datasetLineageCoverage ?? null,
      parseFailures: current?.coverage.sqlParseFailures ?? snapshot?.lineage?.parseFailures.length ?? 0,
      semanticAssets: current?.coverage.semanticAssets ?? snapshot?.semanticAssets?.length ?? 0,
      findings: inv.findings.length,
    },
    analysisCases: [analysisCase],
    gaps,
    targetArchitecture,
    migrationStages: [
      { id: 'stage:baseline', name: 'Current-State Baseline', objective: 'Freeze the discovered estate, evidence and coverage before redesign.', outputs: ['current-state report', 'evidence index'], blockedByGapIds: gaps.filter((g) => g.severity === 'high' && g.kind === 'discovery').map((g) => g.id) },
      { id: 'stage:semantic', name: 'Business Semantics & Source of Truth', objective: 'Resolve business definitions and authoritative sources.', outputs: ['approved semantic context', 'source-of-truth decisions'], blockedByGapIds: gaps.filter((g) => g.kind === 'semantic' || g.title.includes('Source-of-Truth')).map((g) => g.id) },
      { id: 'stage:target', name: 'Target Architecture & Mapping', objective: 'Design the target model and map legacy assets to target assets.', outputs: ['target architecture', 'source-to-target mappings'], blockedByGapIds: gaps.filter((g) => ['lineage', 'architecture'].includes(g.kind) && g.severity === 'high').map((g) => g.id) },
      { id: 'stage:migration', name: 'Migration & Validation', objective: 'Execute migration in controlled waves with reconciliation and cutover criteria.', outputs: ['migration plan', 'validation plan', 'reconciliation results'], blockedByGapIds: gaps.filter((g) => g.severity === 'high').map((g) => g.id) },
    ],
    mappings: [],
    decisions,
    evidenceIds,
  });

  const dir = reportsDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, 'modernization-plan.json');
  await fs.writeFile(fp, JSON.stringify(plan, null, 2), 'utf-8');
  return { plan, path: fp };
}

/** 读取已经生成的 modernization plan；不存在时返回 null。 */
export async function loadModernizationPlan(name: string): Promise<ModernizationPlan | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(reportsDir(name), 'modernization-plan.json'), 'utf-8'));
    return ModernizationPlanSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
