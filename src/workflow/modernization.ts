/**
 * 把已经查到的系统信息整理成一份“接下来怎么改”的计划。
 *
 * 这段代码不替人做最终决定，只负责先把现状、问题、建议和检查方法整理出来，
 * 让分析师和架构师可以继续修改、确认和使用。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import {
  ModernizationPlanSchema,
  SourceToTargetMappingSchema,
  ValidationCheckSchema,
  ValidationPlanSchema,
  type AgentModernizationResult,
  type AnalysisCase,
  type ModernizationPlan,
  type TargetArchitecture,
  type ValidationPlan,
} from '../model/modernization.js';
import type { DiscoverySnapshot } from './discover.js';
import { buildModernizationGaps } from '../analysis/gap.js';
import { buildJourneyState, loadModernizationJourney } from './journey.js';
import { writeJsonAtomic, withWorkspaceContextLock } from '../investigation/workspace.js';
import { assertInvestigationScopeGate } from './scope-gate.js';
import { assertMissionGate } from './mission-gate.js';

function productId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

function now(): string {
  return new Date().toISOString();
}

/** 把真正迁移前要检查的事情列出来，避免到了最后才发现没法验证。 */
function buildValidationPlan(
  current: DiscoverySnapshot['currentState'] | null,
  mappings: ModernizationPlan['mappings'],
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
      name: 'Current-State 基础完整性',
      description: '先确认关键 SQL 已解析，并且数据集连接情况已经查清。',
      status: current ? (current.coverage.sqlParseFailures === 0 ? 'ready' as const : 'blocked' as const) : 'blocked' as const,
      blocking: true,
      evidenceIds,
    },
    {
      id: 'validation:lineage',
      type: 'lineage' as const,
      name: '关键链路完整性',
      description: '确认当前发现的数据集都已经出现在血缘连接里；这只是图上的连接完整性，不等于业务 Source-of-Truth 已确认。',
      status: current
        && current.coverage.sqlParseFailures === 0
        && current.coverage.datasetLineageConnectionRate === 1
        ? 'ready' as const
        : 'blocked' as const,
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

/** 初始阶段只记录“待设计”，不根据资产名字自动编造目标组件、方案原则或架构决定。 */
function buildTargetArchitecture(
  goal: string,
  gaps: ReturnType<typeof buildModernizationGaps>,
): TargetArchitecture {
  const timestamp = now();
  return {
    id: productId('target'),
    type: 'target_architecture',
    title: '目标架构（待设计）',
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    evidenceIds: [],
    findingIds: [],
    decisionIds: [],
    principles: [],
    components: [],
    openQuestions: [
      goal ? '这次改造要保留哪些业务结果和范围？' : '先明确这次改造要保留哪些业务结果和范围。',
      '哪些关键业务问题已经有证据，哪些仍然需要调查？',
      '关键业务数据的权威来源和业务定义是什么？',
      ...gaps.slice(0, 10).map((gap) => gap.title),
    ],
  };
}

/** 把这次整理出来的内容保存下来，UI 和助手以后都能继续用。 */
export async function buildModernizationPlan(name: string): Promise<{ plan: ModernizationPlan; path: string }> {
  // 正式阶段成果不能在范围仍是 unset 时生成；先通过独立 Scope Gate。
  const inv = await loadInvestigation(name);
  assertMissionGate(inv.mission);
  await assertInvestigationScopeGate(name);
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
  const decisions: ModernizationPlan['decisions'] = [];
  const mappings: ModernizationPlan['mappings'] = [];
  const validationPlan = buildValidationPlan(current, mappings, gaps, evidenceIds, inv.scope);
  const journeyDefinition = await loadModernizationJourney();
  const journey = buildJourneyState(journeyDefinition, {
    goal: inv.goal || inv.userPrompt,
    scopeReady: inv.scopeValidation?.status === 'validated',
    currentState: current ? {
      datasets: current.coverage.datasets,
      semanticAssets: current.coverage.semanticAssets,
      parseFailures: current.coverage.sqlParseFailures,
    } : null,
    unknowns: inv.unknowns,
    highGapKinds: gaps.filter((gap) => gap.severity === 'high').map((gap) => gap.kind),
    // target/mapping 的 draft/proposed 产物不能算“通关”；否则刚生成计划，地图就会跳过真正的工作。
    targetComponentCount: targetArchitecture.status === 'draft' ? 0 : targetArchitecture.components.length,
    mappingCount: mappings.filter((mapping) => ['reviewed', 'approved'].includes(mapping.status)).length,
    blockingValidationReady: validationPlan.checks.filter(
      (check) => check.blocking && ['ready', 'passed'].includes(check.status),
    ).length,
    blockingValidationTotal: validationPlan.checks.filter((check) => check.blocking).length,
  });
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
      lineageCoverage: current?.coverage.datasetLineageConnectionRate ?? null,
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
    journey,
    evidenceIds,
  });

  const dir = reportsDir(name);
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, 'modernization-plan.json');
  await fs.writeFile(fp, JSON.stringify(plan, null, 2), 'utf-8');
  return { plan, path: fp };
}

/**
 * 保存 Agent 在 target / mapping / validation 阶段形成的结构化工作成果。
 *
 * 注意顺序：这个函数必须在 Workflow transition 前执行。即使 Agent 回复了
 * workflow.success，没有落盘的成果也不可能通过后面的 Script Gate。
 *
 * 服务端自己生成 work product 的 id/version/time；Agent 不能靠 approved 直接
 * 取得人工批准状态。Evidence 只接受 Investigation 中已经存在的 id。
 */
export async function persistModernizationAgentResult(
  name: string,
  result: AgentModernizationResult | undefined,
): Promise<{ saved: boolean; path?: string; changedSections: string[] }> {
  if (!result) return { saved: false, changedSections: [] };

  // 这个函数也可能被 Workflow / CLI 直接调用；Modernization 工作成果必须绑定已确认 Mission。
  const preflight = await loadInvestigation(name);
  assertMissionGate(preflight.mission);

  return withWorkspaceContextLock(name, async () => {
    let plan = await loadModernizationPlan(name);
    if (!plan) plan = (await buildModernizationPlan(name)).plan;

    const inv = await loadInvestigation(name);
    const knownEvidence = new Set(inv.evidence.map((item) => item.id));
    const timestamp = now();
    const changedSections: string[] = [];

    let targetArchitecture = plan.targetArchitecture;
    if (result.targetArchitecture) {
      const input = result.targetArchitecture;
      const evidenceIds = [...new Set([
        ...targetArchitecture.evidenceIds,
        ...(input.evidenceIds ?? []).filter((id) => knownEvidence.has(id)),
      ])];

      targetArchitecture = ModernizationPlanSchema.shape.targetArchitecture.parse({
        ...targetArchitecture,
        title: input.title ?? targetArchitecture.title,
        status: input.status === 'approved'
          ? 'in_review'
          : input.status ?? targetArchitecture.status,
        version: targetArchitecture.version + 1,
        updatedAt: timestamp,
        evidenceIds,
        principles: input.principles ?? targetArchitecture.principles,
        components: input.components ?? targetArchitecture.components,
        openQuestions: input.openQuestions ?? targetArchitecture.openQuestions,
      });
      changedSections.push('targetArchitecture');
    }

    let mappings = plan.mappings;
    if (result.mappings?.length) {
      const byId = new Map(mappings.map((mapping) => [mapping.id, mapping]));

      for (const input of result.mappings) {
        const stableId = input.id
          ?? 'mapping-' + crypto.createHash('sha1')
            .update(input.sourceAsset + '\n' + input.targetAsset)
            .digest('hex')
            .slice(0, 16);

        const existing = byId.get(stableId)
          ?? mappings.find((mapping) =>
            mapping.sourceAsset === input.sourceAsset
            && mapping.targetAsset === input.targetAsset,
          );

        const evidenceIds = [...new Set([
          ...(existing?.evidenceIds ?? []),
          ...(input.evidenceIds ?? []).filter((id) => knownEvidence.has(id)),
        ])];

        // reviewed / approved 是人工语义，Agent 只能留下 proposed。
        const status = input.status === 'approved' || input.status === 'reviewed'
          ? 'proposed' as const
          : input.status ?? existing?.status ?? 'proposed';

        const mapping = SourceToTargetMappingSchema.parse({
          ...(existing ?? {}),
          id: existing?.id ?? stableId,
          type: 'source_to_target' as const,
          title: existing?.title ?? (input.sourceAsset + ' → ' + input.targetAsset),
          status,
          version: (existing?.version ?? 0) + 1,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          evidenceIds,
          findingIds: existing?.findingIds ?? [],
          decisionIds: existing?.decisionIds ?? [],
          sourceAsset: input.sourceAsset,
          targetAsset: input.targetAsset,
          ...(input.transformation !== undefined ? { transformation: input.transformation } : {}),
          ...(input.businessRule !== undefined ? { businessRule: input.businessRule } : {}),
          ...(input.validationRule !== undefined ? { validationRule: input.validationRule } : {}),
        });

        byId.set(mapping.id, mapping);
      }

      mappings = [...byId.values()];
      changedSections.push('mappings');
    }

    const mappingCoverage = result.mappingCoverage
      ? {
          sourceAssets: [...new Set(result.mappingCoverage.sourceAssets)],
          unmappedAssets: [...new Set(result.mappingCoverage.unmappedAssets)],
        }
      : plan.mappingCoverage;

    let validationPlan = plan.validationPlan;
    if (result.validation) {
      const checksById = new Map(validationPlan.checks.map((check) => [check.id, check]));

      for (const input of result.validation.checks) {
        const existing = checksById.get(input.id);
        const evidenceIds = [...new Set([
          ...(existing?.evidenceIds ?? []),
          ...(input.evidenceIds ?? []).filter((id) => knownEvidence.has(id)),
        ])];

        const check = ValidationCheckSchema.parse({
          ...(existing ?? {}),
          id: input.id,
          type: input.type,
          name: input.name,
          description: input.description,
          // 已存在的 blocking 规则不能由 Agent 在运行时修改。
          blocking: existing?.blocking ?? input.blocking,
          status: input.status,
          evidenceIds,
          ...(input.result !== undefined
            ? { result: input.result }
            : existing?.result !== undefined
              ? { result: existing.result }
              : {}),
        });

        checksById.set(check.id, check);
      }

      validationPlan = ValidationPlanSchema.parse({
        ...validationPlan,
        status: 'in_review',
        version: validationPlan.version + 1,
        updatedAt: timestamp,
        checks: [...checksById.values()],
        ...(result.validation.cutoverCriteria
          ? { cutoverCriteria: result.validation.cutoverCriteria }
          : {}),
        ...(result.validation.rollbackCriteria
          ? { rollbackCriteria: result.validation.rollbackCriteria }
          : {}),
      });
      changedSections.push('validationPlan');
    }

    const nextPlan = ModernizationPlanSchema.parse({
      ...plan,
      version: plan.version + 1,
      targetArchitecture,
      mappings,
      validationPlan,
      ...(mappingCoverage ? { mappingCoverage } : {}),
      evidenceIds: [...new Set([
        ...plan.evidenceIds,
        ...targetArchitecture.evidenceIds,
        ...mappings.flatMap((mapping) => mapping.evidenceIds),
        ...validationPlan.checks.flatMap((check) => check.evidenceIds),
      ])],
    });

    const dir = reportsDir(name);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'modernization-plan.json');
    await writeJsonAtomic(filePath, nextPlan);

    return {
      saved: true,
      path: filePath,
      changedSections,
    };
  });
}

/** 读取已经保存的改造计划；还没有生成时就返回空。 */
export async function loadModernizationPlan(name: string): Promise<ModernizationPlan | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(reportsDir(name), 'modernization-plan.json'), 'utf-8'));
    const plan = ModernizationPlanSchema.parse(raw);
    const inv = await loadInvestigation(name);
    const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
    const current = snapshot?.currentState ?? null;
    const gaps = buildModernizationGaps({
      currentState: current,
      estate: snapshot?.estate,
      findings: inv.findings,
    });
    const journey = buildJourneyState(await loadModernizationJourney(), {
      goal: inv.goal || inv.userPrompt,
      currentState: current ? {
        datasets: current.coverage.datasets,
          semanticAssets: current.coverage.semanticAssets,
        parseFailures: current.coverage.sqlParseFailures,
      } : null,
      unknowns: inv.unknowns,
      highGapKinds: gaps.filter((gap) => gap.severity === 'high').map((gap) => gap.kind),
      targetComponentCount: plan.targetArchitecture.status === 'draft'
        ? 0
        : plan.targetArchitecture.components.length,
      mappingCount: plan.mappings.filter((mapping) => ['reviewed', 'approved'].includes(mapping.status)).length,
      blockingValidationReady: plan.validationPlan.checks.filter(
        (check) => check.blocking && ['ready', 'passed'].includes(check.status),
      ).length,
      blockingValidationTotal: plan.validationPlan.checks.filter((check) => check.blocking).length,
    });

    return { ...plan, journey };
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
