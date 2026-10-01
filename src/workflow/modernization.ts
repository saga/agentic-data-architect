/**
 * 把已经查到的系统信息整理成一份“接下来怎么改”的计划。
 *
 * 这段代码不替人做最终决定，只负责先把现状、问题、建议和检查方法整理出来，
 * 让分析师和架构师可以继续修改、确认和使用。
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

/** 先把旧数据和新数据大致对应起来，给后面人工确认打个底。 */
function buildInitialMappings(
  current: DiscoverySnapshot['currentState'] | null,
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
      title: `建议对应：${source || 'legacy asset'} → ${key}`,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      evidenceIds: [...new Set([...candidate.evidenceIds, ...evidenceIds.slice(0, 3)])],
      findingIds: [],
      decisionIds: [],
      sourceAsset: source || `unknown:${index + 1}`,
      targetAsset: `target:domain-data:${key}`,
      transformation: '还需要继续看现有 SQL 和 ETL，才能确定具体怎么转换。现在只是先把“旧数据放到哪里”画出来。',
      businessRule: '还需要业务人员确认这个数据到底代表什么，以及哪一个系统是准的。',
      validationRule: '改造前后对比关键记录、数量、金额和时间范围，确认结果一致。',
      status: 'proposed',
    };
  });
}

/** 把真正迁移前要检查的事情列出来，避免到了最后才发现没法验证。 */
function buildValidationPlan(
  current: DiscoverySnapshot['currentState'] | null,
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
      description: '先确认关键 SQL、数据集和上下游关系已经查得比较完整。',
      status: current ? (current.coverage.sqlParseFailures === 0 ? 'ready' as const : 'blocked' as const) : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:lineage',
      type: 'lineage' as const,
      name: '关键链路完整性',
      description: '确认关键数据从哪里来、流向哪里，而且人工抽查过。',
      status: current?.coverage.datasetLineageCoverage !== null && (current?.coverage.datasetLineageCoverage ?? 0) >= 0.8 ? 'ready' as const : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:semantic',
      type: 'semantic' as const,
      name: '业务语义与权威源确认',
      description: '确认重要指标和业务定义有明确依据，也确认哪个来源最可信。',
      status: (current?.coverage.semanticAssets ?? 0) > 0 && current?.sourceOfTruthCandidates.length === 0 ? 'ready' as const : 'planned' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:mapping',
      type: 'mapping' as const,
      name: '把旧数据对应到新数据 完整性',
      description: '确认要迁移的数据都有新的去处，而且知道怎么改、怎么检查。',
      status: mappings.length > 0 ? 'ready' as const : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:reconciliation',
      type: 'reconciliation' as const,
      name: '改造前后数据对比',
      description: '对关键业务主键、数量、金额、记录数和时间窗口执行 source/target reconciliation。',
      status: 'planned' as const,
      blocking: true,
      evidenceIds: [],
    },
    {
      id: 'validation:quality',
      type: 'quality' as const,
      name: '检查数据有没有出问题',
      description: '执行 null、duplicate、referential integrity、freshness 和关键业务规则回归。',
      status: 'planned' as const,
      blocking: false,
      evidenceIds: [],
    },
    {
      id: 'validation:cutover',
      type: 'cutover' as const,
      name: 'Cutover / Rollback readiness',
      description: '在真正切换前，先说清楚什么时候可以切、出了问题什么时候退回去。',
      status: hasHighGap ? 'blocked' as const : 'planned' as const,
      blocking: true,
      evidenceIds: [],
    },
  ];

  return {
    id: productId('validation'),
    type: 'modernization_plan',
    title: '改造检查清单',
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
      '所有必须通过的检查都通过，或者已经由负责人明确确认可以例外。',
      '关键业务指标在允许的误差范围内。',
      '数据来源、业务定义、转换规则和回退依据都已经留下记录。',
    ],
    rollbackCriteria: [
      '关键业务指标一直超出允许误差。',
      '出现说不清原因的数据缺失、重复或时间错误。',
      '新旧系统的重要依赖还不够稳定。',
    ],
  };
}

/** 给分析师留一个明确的问题和两步起始动作，后面可以继续补充。 */
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
    question: goal || '这个老系统现在是怎么工作的？哪些地方最需要先改？',
    scope,
    hypotheses: [],
    steps: [
      {
        id: productId('step'),
        title: '先把现状查清楚',
        action: '先看看已经查清了什么、还缺什么，再决定怎么改。',
        status: 'planned',
        evidenceIds,
      },
      {
        id: productId('step'),
        title: '找出还没解决的问题',
        action: '先处理会影响数据来源、业务定义和改造范围的问题。',
        status: 'planned',
        evidenceIds,
      },
    ],
  };
}

/** 先给一个不绑死具体产品的方案草稿；它只是起点，必须经过人工确认。 */
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
    title: '目标方案草案',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds: gaps.flatMap((g) => g.evidenceIds),
    findingIds: gaps.filter((g) => g.kind === 'data_quality' || g.kind === 'architecture').map((g) => g.id),
    decisionIds: [],
    principles: [
      '重要业务含义要说清楚，而且能找到依据。',
      '存储和处理技术以后可以换，不要把方案锁死在某个产品上。',
      '真正切换之前，要说清数据从哪里来、怎么流、怎么检查。',
      '这是一个需要人审核的方案，不是 Agent 说了就算。',
    ],
    components: [
      {
        id: 'target:source',
        type: 'source',
        name: '老系统和外部数据',
        description: '现在还在使用的数据库、文件、接口和外部数据来源。',
        dependsOn: [],
        sourceAssets,
      },
      {
        id: 'target:ingestion',
        type: 'ingestion',
        name: '把数据接进来',
        description: '规定数据怎么进来、多久更新一次、出问题怎么处理。',
        dependsOn: ['target:source'],
        sourceAssets: [],
      },
      {
        id: 'target:domain-data',
        type: 'domain_data',
        name: '整理后的业务数据',
        description: '按业务来整理数据，并说清楚谁负责、哪个来源最可信。',
        dependsOn: ['target:ingestion'],
        sourceAssets: sourceAssets.slice(0, 50),
      },
      {
        id: 'target:transformation',
        type: 'transformation',
        name: '业务规则和计算',
        description: '把业务计算和数据接入分开，这样更容易检查和迁移。',
        dependsOn: ['target:domain-data'],
        sourceAssets: [],
      },
      {
        id: 'target:semantic',
        type: 'semantic',
        name: '业务定义和指标',
        description: '把业务定义、指标和口径集中说明。Snowflake Semantic View 或 Data Product 都可以作为来源。',
        dependsOn: ['target:domain-data', 'target:transformation'],
        sourceAssets: sourceAssets.slice(0, 50),
      },
      {
        id: 'target:serving',
        type: 'serving',
        name: '报表和应用',
        description: '报表、看板、研究分析和其他使用这些数据的应用。',
        dependsOn: ['target:semantic'],
        sourceAssets: [],
      },
      {
        id: 'target:governance',
        type: 'governance',
        name: '质量、来源和权限',
        description: '用来检查数据、追踪来源、控制权限和留下记录。',
        dependsOn: ['target:ingestion', 'target:domain-data', 'target:semantic', 'target:serving'],
        sourceAssets: [],
      },
    ],
    openQuestions: [
      goal ? `这次改造必须保留哪些业务结果和范围： ${goal}` : '这次改造必须保留哪些业务结果和范围？',
      ...gapIds.map((id) => `解决这个问题：${id}`),
    ],
  };
}

/** 先留一个设计决定的位置，真正的决定还要看资料并由人确认。 */
function buildInitialDecisions(): ArchitectureDecision[] {
  const timestamp = now();
  return [{
    id: productId('decision'),
    type: 'architecture_decision',
    title: '业务定义不要绑死在一个产品上',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds: [],
    findingIds: [],
    decisionIds: [],
    context: '我们需要理解业务含义，但不能因为用了某个平台，就把整个系统绑死在这个平台上。',
    options: [
      '把 Snowflake 当成唯一的业务定义来源',
      '使用通用的业务定义接口',
    ],
    decision: '使用通用的业务定义接口.',
    rationale: 'Snowflake 可以提供大量业务定义，但其他目录、数据产品和业务文档也应该可以接进来。',
    tradeoffs: [
      '不同来源需要各自的接入方式。',
      '某些平台特有的信息暂时保留，之后再统一。',
    ],
  }];
}

/** 把这次整理出来的内容保存下来，UI 和助手以后都能继续用。 */
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
    title: inv.goal || '老系统改造计划',
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
      { id: 'stage:baseline', name: '先把现状定下来', objective: '先把已经查到的系统、证据和范围记录下来，再开始设计。', outputs: ['现状报告', '证据清单'], blockedByGapIds: gaps.filter((g) => g.severity === 'high' && g.kind === 'discovery').map((g) => g.id) },
      { id: 'stage:semantic', name: '确认业务定义和可信来源', objective: '确认指标和业务定义，也确认哪个来源最可信。', outputs: ['已确认的业务定义', '可信来源结论'], blockedByGapIds: gaps.filter((g) => g.kind === 'semantic' || g.title.includes('Source-of-Truth')).map((g) => g.id) },
      { id: 'stage:target', name: '设计新的方案', objective: '确定新的数据怎么流、怎么整理、业务定义放哪里、怎么管。', outputs: ['新的方案'], blockedByGapIds: gaps.filter((g) => ['lineage', 'architecture'].includes(g.kind) && g.severity === 'high').map((g) => g.id) },
      { id: 'stage:mapping', name: '把旧数据对应到新数据', objective: '把要迁移的旧数据对应到新的数据，并写清楚中间怎么改。', outputs: ['新旧数据对应关系'], blockedByGapIds: gaps.filter((g) => ['lineage', 'mapping'].includes(g.kind) && g.severity === 'high').map((g) => g.id) },
      { id: 'stage:validation', name: '检查改造结果', objective: '提前列出明确的检查方法，确认数据、业务口径和切换条件都没问题。', outputs: ['检查清单', '前后对比结果'], blockedByGapIds: gaps.filter((g) => g.severity === 'high').map((g) => g.id) },
      { id: 'stage:migration', name: '分批迁移和切换', objective: '按批次迁移已经确认的方案，并按照事先说好的条件切换或退回去。', outputs: ['迁移批次计划', '切换检查清单', '退回方案'], blockedByGapIds: gaps.filter((g) => g.severity === 'high').map((g) => g.id) },
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

/** 读取已经保存的改造计划；还没有生成时就返回空。 */
export async function loadModernizationPlan(name: string): Promise<ModernizationPlan | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(reportsDir(name), 'modernization-plan.json'), 'utf-8'));
    return ModernizationPlanSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
