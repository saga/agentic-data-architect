/**
 * Legacy Modernization 主工作流。
 *
 * 这不是另一个 Agent framework；它只是把已有 Discovery / Current-State 结果
 * 组织成 Data Analyst + Data Architect 可以继续编辑、审核和交付的工作包。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import {
  ModernizationPlanSchema,
  type AnalysisCase,
  type ArchitectureDecision,
  type ModernizationPlan,
  type TargetArchitecture,
  type SourceToTargetMapping,
  type ValidationPlan,
} from '../model/modernization.js';
import type { DiscoverySnapshot } from './discover.js';
import { buildModernizationGaps } from '../analysis/gap.js';

function productId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** 把物理资产名转成目标数据域的可读 key；只是命名建议，不代表业务模型已确认。 */
function targetKey(name: string): string {
  const last = name.replace(/"/g, '').split('.').filter(Boolean).at(-1) || name;
  return last.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** 为首版 modernization package 生成可审阅的 dataset-level mapping 建议。 */
function buildInitialMappings(
  current: DiscoverySnapshot['currentState'],
  evidenceIds: string[],
): SourceToTargetMapping[] {
  if (!current) return [];

  const candidates = current.sourceOfTruthCandidates.length > 0
    ? current.sourceOfTruthCandidates
    : current.highValueAssets.map((dataset) => ({
        key: targetKey(dataset),
        candidateDatasetIds: [],
        candidateDatasets: [dataset],
        score: 0,
        reasons: ['Current-State high-value asset'],
        evidenceIds: [],
      }));

  return candidates.slice(0, 30).map((candidate, index) => {
    const timestamp = now();
    const source = candidate.candidateDatasets[0] ?? current.highValueAssets[index];
    const key = targetKey(candidate.key || source || `asset_${index + 1}`);
    return {
      id: productId('mapping'),
      type: 'source_to_target',
      title: `候选映射：${source || 'legacy asset'} → ${key}`,
      status: 'draft',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      evidenceIds: [...new Set([...candidate.evidenceIds, ...evidenceIds.slice(0, 3)])],
      findingIds: [],
      decisionIds: [],
      sourceAsset: source || `unknown:${index + 1}`,
      targetAsset: `target:domain-data:${key}`,
      transformation: '待解析现有 SQL / ETL transformation 后确定；当前仅建立 dataset-level mapping skeleton。',
      businessRule: '待业务语义和 Source-of-Truth review 后确认。',
      validationRule: '迁移前后按业务主键、记录数、关键指标和时间范围进行对账。',
      status: 'proposed',
    };
  });
}

/** 生成首版 Validation Plan，把迁移前必须回答的问题显式化。 */
function buildValidationPlan(
  current: DiscoverySnapshot['currentState'],
  mappings: SourceToTargetMapping[],
  gaps: ReturnType<typeof buildModernizationGaps>,
  evidenceIds: string[],
  scope: string[],
): ValidationPlan {
  const timestamp = now();
  const hasHighGap = gaps.some((gap) => gap.severity === 'high');
  const checks = [
    {
      id: 'validation:coverage',
      type: 'coverage' as const,
      name: 'Current-State 覆盖率',
      description: '确认关键 SQL、Dataset、Lineage 和 Profiling 已达到迁移设计所需覆盖水平。',
      status: current ? (current.coverage.sqlParseFailures === 0 ? 'ready' as const : 'blocked' as const) : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:lineage',
      type: 'lineage' as const,
      name: '关键链路完整性',
      description: '确认迁移范围内关键数据集的上下游依赖已被发现并经过人工抽查。',
      status: current?.coverage.datasetLineageCoverage !== null && (current?.coverage.datasetLineageCoverage ?? 0) >= 0.8 ? 'ready' as const : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:semantic',
      type: 'semantic' as const,
      name: '业务语义与权威源确认',
      description: '确认核心概念、指标、时间语义和 Source-of-Truth 已有可追踪的业务依据。',
      status: (current?.coverage.semanticAssets ?? 0) > 0 && current?.sourceOfTruthCandidates.length === 0 ? 'ready' as const : 'planned' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:mapping',
      type: 'mapping' as const,
      name: 'Source-to-Target Mapping 完整性',
      description: '确认所有 in-scope legacy assets 都有目标对象、转换规则和验证规则。',
      status: mappings.length > 0 ? 'ready' as const : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:reconciliation',
      type: 'reconciliation' as const,
      name: '迁移前后数据对账',
      description: '对关键业务主键、数量、金额、记录数和时间窗口执行 source/target reconciliation。',
      status: 'planned' as const,
      blocking: true,
      evidenceIds: [],
    },
    {
      id: 'validation:quality',
      type: 'quality' as const,
      name: '数据质量回归',
      description: '执行 null、duplicate、referential integrity、freshness 和关键业务规则回归。',
      status: 'planned' as const,
      blocking: false,
      evidenceIds: [],
    },
    {
      id: 'validation:cutover',
      type: 'cutover' as const,
      name: 'Cutover / Rollback readiness',
      description: '明确切换门槛、监控窗口、回退条件和责任人后再进入 cutover。',
      status: hasHighGap ? 'blocked' as const : 'planned' as const,
      blocking: true,
      evidenceIds: [],
    },
  ];

  return {
    id: productId('validation'),
    type: 'modernization_plan',
    title: 'Modernization Validation Plan',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds: [...new Set(evidenceIds)],
    findingIds: [],
    decisionIds: [],
    scope,
    checks,
    cutoverCriteria: [
      '所有 blocking validation check 已通过或获得明确人工豁免。',
      '关键 business metric reconciliation 在允许误差范围内。',
      'Lineage、semantic definition、mapping 和 rollback evidence 已完整归档。',
    ],
    rollbackCriteria: [
      '关键业务指标持续超出允许误差。',
      '出现无法解释的数据缺失、重复或时序错误。',
      '新旧系统关键依赖尚未达到约定稳定性门槛。',
    ],
  };
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
function buildTargetArchitecture(
  goal: string,
  gaps: ReturnType<typeof buildModernizationGaps>,
  sourceAssets: string[],
): TargetArchitecture {
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
        sourceAssets,
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
        sourceAssets: sourceAssets.slice(0, 50),
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
        sourceAssets: sourceAssets.slice(0, 50),
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
  const sourceAssets = current?.highValueAssets ?? [];
  const targetArchitecture = buildTargetArchitecture(inv.goal || inv.userPrompt, gaps, sourceAssets);
  const decisions = buildInitialDecisions();
  const mappings = buildInitialMappings(current, evidenceIds);
  const validationPlan = buildValidationPlan(current, mappings, gaps, evidenceIds, inv.scope);
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
      { id: 'stage:target', name: 'Target Architecture', objective: 'Define the target data flow, domain data, semantic layer and governance boundary.', outputs: ['target architecture'], blockedByGapIds: gaps.filter((g) => ['lineage', 'architecture'].includes(g.kind) && g.severity === 'high').map((g) => g.id) },
      { id: 'stage:mapping', name: 'Source-to-Target Mapping', objective: 'Map in-scope legacy assets to target assets and make transformation/business rules explicit.', outputs: ['source-to-target mappings'], blockedByGapIds: gaps.filter((g) => ['lineage', 'mapping'].includes(g.kind) && g.severity === 'high').map((g) => g.id) },
      { id: 'stage:validation', name: 'Validation & Reconciliation', objective: 'Define deterministic checks for data quality, reconciliation, semantic correctness and cutover readiness.', outputs: ['validation plan', 'reconciliation results'], blockedByGapIds: gaps.filter((g) => g.severity === 'high').map((g) => g.id) },
      { id: 'stage:migration', name: 'Migration Waves & Cutover', objective: 'Move the approved design in controlled waves and apply cutover/rollback criteria.', outputs: ['migration wave plan', 'cutover checklist', 'rollback plan'], blockedByGapIds: gaps.filter((g) => g.severity === 'high').map((g) => g.id) },
    ],
    mappings,
    decisions,
    validationPlan,
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
