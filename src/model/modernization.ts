/**
 * Legacy Modernization 工作台的核心工作产物模型。
 *
 * 这些对象描述 Data Analyst / Data Architect 真正要交付的内容：
 * 分析 Case、Target Architecture、Source-to-Target Mapping、Architecture Decision
 * 和最终的 Modernization Plan。它们都保留 Evidence 引用，但不把 Evidence 嵌进来。
 */
import * as z from 'zod';
import { ArtifactProvenanceSchema } from '../api/contracts.js';
export const WorkProductStatusSchema = z.enum(['draft', 'in_review', 'approved', 'rejected']);
export type WorkProductStatus = z.infer<typeof WorkProductStatusSchema>;

export const WorkProductTypeSchema = z.enum([
  'analysis_case',
  'target_architecture',
  'source_to_target',
  'architecture_decision',
  'modernization_plan',
]);
export type WorkProductType = z.infer<typeof WorkProductTypeSchema>;

/** 所有可持久化工作产物共有的最小字段。 */
export const WorkProductBaseSchema = z.object({
  id: z.string().min(1),
  type: WorkProductTypeSchema,
  title: z.string().min(1),
  status: WorkProductStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  evidenceIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  decisionIds: z.array(z.string()),
}).strict();
export type WorkProductBase = z.infer<typeof WorkProductBaseSchema>;

/** Data Analyst 使用的一个分析 Case：问题、假设、分析步骤和结论。 */
export const AnalysisCaseSchema = WorkProductBaseSchema.extend({
  type: z.literal('analysis_case'),
  question: z.string().min(1),
  scope: z.array(z.string()),
  hypotheses: z.array(z.string()),
  steps: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    action: z.string().min(1),
    status: z.enum(['planned', 'running', 'completed', 'blocked']),
    evidenceIds: z.array(z.string()),
    notes: z.string().optional(),
  }).strict()),
  conclusion: z.string().optional(),
}).strict();
export type AnalysisCase = z.infer<typeof AnalysisCaseSchema>;

/** Target Architecture 中一个逻辑组件；不绑定具体云厂商或数据库产品。 */
export const TargetComponentSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['source', 'ingestion', 'domain_data', 'transformation', 'semantic', 'serving', 'governance']),
  name: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string()),
  sourceAssets: z.array(z.string()),
}).strict();
export type TargetComponent = z.infer<typeof TargetComponentSchema>;

/** Data Architect 的 Target Architecture 草案。 */
export const TargetArchitectureSchema = WorkProductBaseSchema.extend({
  type: z.literal('target_architecture'),
  principles: z.array(z.string()),
  components: z.array(TargetComponentSchema),
  openQuestions: z.array(z.string()),
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'draft' && (value.components.length === 0 || value.evidenceIds.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['components'],
      message: '非草案的目标架构必须有实际组件和证据。',
    });
  }
});
export type TargetArchitecture = z.infer<typeof TargetArchitectureSchema>;

/** 单条 Source-to-Target Mapping，明确物理来源、目标和转换规则。 */
export const SourceToTargetMappingSchema = WorkProductBaseSchema.extend({
  type: z.literal('source_to_target'),
  sourceAsset: z.string().min(1),
  targetAsset: z.string().min(1),
  transformation: z.string().optional(),
  businessRule: z.string().optional(),
  validationRule: z.string().optional(),
  status: z.enum(['proposed', 'reviewed', 'approved', 'rejected']),
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'proposed' && value.evidenceIds.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceIds'],
      message: '已审核或已批准的 Mapping 必须保留证据。',
    });
  }
});
export type SourceToTargetMapping = z.infer<typeof SourceToTargetMappingSchema>;

/** Architecture Decision Record 的轻量模型，避免引入重量级 ADR/BPMN 系统。 */
export const ArchitectureDecisionSchema = WorkProductBaseSchema.extend({
  type: z.literal('architecture_decision'),
  context: z.string().min(1),
  options: z.array(z.string()).min(2),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  tradeoffs: z.array(z.string()),
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'draft' && value.evidenceIds.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidenceIds'],
      message: '已审核或已批准的架构决定必须保留证据。',
    });
  }
});
export type ArchitectureDecision = z.infer<typeof ArchitectureDecisionSchema>;

/** modernization 中一个待解决的结构性 Gap。 */
/** 单条迁移/验证检查，明确检查什么、当前状态和是否阻塞。 */
export const ValidationCheckSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['coverage', 'lineage', 'semantic', 'mapping', 'reconciliation', 'quality', 'cutover']),
  name: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(['planned', 'ready', 'passed', 'failed', 'blocked']),
  blocking: z.boolean(),
  evidenceIds: z.array(z.string()),
  /** passed / failed 应当留下实际检查结果；Gate 会强制检查这一点。 */
  result: z.string().trim().optional(),
}).strict();
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

/**
 * Agent 在 target / mapping / validation 阶段提交的最小工作成果。
 *
 * id / version / 时间戳等元数据由服务端生成；Agent 不能靠 approved 直接取得人工审批状态。
 */
export const AgentModernizationResultSchema = z.object({
  targetArchitecture: z.object({
    title: z.string().trim().min(1).optional(),
    status: z.enum(['draft', 'in_review', 'approved']).optional(),
    principles: z.array(z.string().trim().min(1)).optional(),
    components: z.array(TargetComponentSchema).optional(),
    openQuestions: z.array(z.string().trim().min(1)).optional(),
    evidenceIds: z.array(z.string()).optional(),
  }).strict().optional(),
  mappings: z.array(z.object({
    id: z.string().trim().min(1).optional(),
    sourceAsset: z.string().trim().min(1),
    targetAsset: z.string().trim().min(1),
    transformation: z.string().trim().optional(),
    businessRule: z.string().trim().optional(),
    validationRule: z.string().trim().optional(),
    status: z.enum(['proposed', 'reviewed', 'approved', 'rejected']).optional(),
    evidenceIds: z.array(z.string()).optional(),
  }).strict()).optional(),
  /**
   * 明确本轮 Mapping 覆盖范围。Gate 不会把“模型说都对应了”当成覆盖证明，
   * 但没有这份记录则连“覆盖范围已经明确”都无法验证。
   */
  mappingCoverage: z.object({
    sourceAssets: z.array(z.string().trim().min(1)),
    unmappedAssets: z.array(z.string().trim().min(1)),
    unmappedAssetDispositions: z.array(z.object({
      asset: z.string().trim().min(1),
      disposition: z.enum(['excluded', 'deprecated', 'obsolete', 'out-of-scope', 'requires-review']),
      reason: z.string().trim().min(1),
    }).strict()).optional(),
  }).strict().optional(),
  validation: z.object({
    checks: z.array(z.object({
      id: z.string().trim().min(1),
      type: z.enum(['coverage', 'lineage', 'semantic', 'mapping', 'reconciliation', 'quality', 'cutover']),
      name: z.string().trim().min(1),
      description: z.string().trim().min(1),
      status: z.enum(['planned', 'ready', 'passed', 'failed', 'blocked']),
      blocking: z.boolean(),
      evidenceIds: z.array(z.string()).optional(),
      result: z.string().trim().optional(),
    }).strict()),
    cutoverCriteria: z.array(z.string().trim().min(1)).optional(),
    rollbackCriteria: z.array(z.string().trim().min(1)).optional(),
  }).strict().optional(),
}).strict();
export type AgentModernizationResult = z.infer<typeof AgentModernizationResultSchema>;


/** Modernization 的独立 Validation Plan，供 Analyst / Architect 在迁移前审核。 */
export const ValidationPlanSchema = WorkProductBaseSchema.extend({
  type: z.literal('modernization_plan'),
  scope: z.array(z.string()),
  checks: z.array(ValidationCheckSchema),
  cutoverCriteria: z.array(z.string()),
  rollbackCriteria: z.array(z.string()),
}).strict();
export type ValidationPlan = z.infer<typeof ValidationPlanSchema>;

/** modernization 中一个待解决的结构性 Gap。 */
export const ModernizationGapSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['discovery', 'lineage', 'semantic', 'source-of-truth', 'data_quality', 'architecture', 'mapping', 'migration']),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  affectedAssets: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  recommendation: z.string().min(1),
}).strict();
export type ModernizationGap = z.infer<typeof ModernizationGapSchema>;

/** 一次 modernization investigation 的可持续工作包。 */
export const ModernizationPlanSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: WorkProductStatusSchema,
  version: z.number().int().positive(),
  generatedAt: z.string().min(1),
  goal: z.string(),
  scope: z.array(z.string()),
  currentState: z.object({
    datasets: z.number().int().nonnegative(),
    lineageCoverage: z.number().min(0).max(1).nullable(),
    parseFailures: z.number().int().nonnegative(),
    semanticAssets: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
  }).strict(),
  analysisCases: z.array(AnalysisCaseSchema),
  gaps: z.array(ModernizationGapSchema),
  targetArchitecture: TargetArchitectureSchema,
  migrationStages: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    objective: z.string().min(1),
    outputs: z.array(z.string()),
    blockedByGapIds: z.array(z.string()),
  }).strict()),
  mappings: z.array(SourceToTargetMappingSchema),
  decisions: z.array(ArchitectureDecisionSchema),
  validationPlan: ValidationPlanSchema,
  /** Artifact provenance：旧版本没有该字段时，读取路径将视为 stale。 */
  provenance: ArtifactProvenanceSchema.optional(),
  /** Mapping Gate 使用的覆盖范围记录。 */
  mappingCoverage: z.object({
    sourceAssets: z.array(z.string()),
    unmappedAssets: z.array(z.string()),
    unmappedAssetDispositions: z.array(z.object({
      asset: z.string().min(1),
      disposition: z.enum(['excluded', 'deprecated', 'obsolete', 'out-of-scope', 'requires-review']),
      reason: z.string().trim().min(1),
    }).strict()).optional(),
  }).strict().optional(),
  evidenceIds: z.array(z.string()),
}).strict();
export type ModernizationPlan = z.infer<typeof ModernizationPlanSchema>;
