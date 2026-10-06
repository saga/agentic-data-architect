/**
 * “调查结果”页面的唯一 API View Model。
 *
 * 这是 server → web 的边界契约：
 * - checkpoint 是已经通过 Stage Gate 的阶段成果；
 * - result artifact 是已经持久化或已经生成的用户可见工作成果；
 * - 各 section 独立表达 available / empty / blocked / error / not_applicable，
 *   一个结果失败不能让其它结果一起消失。
 */
import * as z from 'zod';
import { WorkflowIdSchema } from '../investigation/schemas.js';

export const ResultCheckpointSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  timestamp: z.string().datetime(),
  execution: z.number().int().nonnegative(),
  title: z.string().min(1),
  summary: z.string().min(1),
  confirmed: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  unknowns: z.array(z.string()),
  nextStep: z.string().optional(),
}).strict();
export type ResultCheckpoint = z.infer<typeof ResultCheckpointSchema>;

export const ResultSessionSchema = z.object({
  name: z.string().min(1),
  workflow: WorkflowIdSchema.nullable(),
  controlVersion: z.number().int().positive(),
  agentDisplayName: z.string().min(1),
}).strict();
export type ResultSession = z.infer<typeof ResultSessionSchema>;

const resultModernizationComponentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  sourceAssets: z.array(z.string()),
}).strict();

const resultModernizationMappingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  sourceAsset: z.string().min(1),
  targetAsset: z.string().min(1),
  transformation: z.string().optional(),
  businessRule: z.string().optional(),
  validationRule: z.string().optional(),
  evidenceIds: z.array(z.string()),
}).strict();

const resultValidationCheckSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  blocking: z.boolean(),
  evidenceIds: z.array(z.string()),
  result: z.string().optional(),
}).strict();

export const ResultModernizationSchema = z.object({
  version: z.number().int().positive(),
  status: z.string().min(1),
  targetArchitecture: z.object({
    title: z.string().min(1),
    status: z.string().min(1),
    principles: z.array(z.string()),
    components: z.array(resultModernizationComponentSchema),
    openQuestions: z.array(z.string()),
    evidenceIds: z.array(z.string()),
  }).strict(),
  mappings: z.array(resultModernizationMappingSchema),
  mappingCoverage: z.object({
    sourceAssets: z.array(z.string()),
    unmappedAssets: z.array(z.string()),
  }).strict().optional(),
  validationPlan: z.object({
    checks: z.array(resultValidationCheckSchema),
    cutoverCriteria: z.array(z.string()),
    rollbackCriteria: z.array(z.string()),
  }).strict(),
}).strict();
export type ResultModernization = z.infer<typeof ResultModernizationSchema>;

export const ResultAssessmentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  version: z.number().int().positive(),
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
}).strict();
export type ResultAssessment = z.infer<typeof ResultAssessmentSchema>;

export const ResultReportSchema = z.object({
  markdown: z.string(),
  review: z.object({
    status: z.enum(['pass', 'fail']),
    availability: z.enum(['completed', 'unavailable']),
    score: z.number().int().min(0).max(100),
    summary: z.string().min(1),
    issueCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type ResultReport = z.infer<typeof ResultReportSchema>;

export const ResultSectionSchema = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), data }).strict(),
  z.object({ status: z.literal('empty'), message: z.string().optional() }).strict(),
  z.object({ status: z.literal('blocked'), message: z.string().min(1) }).strict(),
  z.object({ status: z.literal('error'), message: z.string().min(1) }).strict(),
  z.object({ status: z.literal('not_applicable') }).strict(),
]);
export type ResultSection<T> =
  | { status: 'available'; data: T }
  | { status: 'empty'; message?: string }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string }
  | { status: 'not_applicable' };

export const ResultViewModelSchema = z.object({
  schemaVersion: z.literal(1),
  session: ResultSessionSchema,
  checkpoints: z.array(ResultCheckpointSchema),
  modernization: ResultSectionSchema(ResultModernizationSchema),
  assessment: ResultSectionSchema(ResultAssessmentSchema),
  report: ResultSectionSchema(ResultReportSchema),
}).strict();
export type ResultViewModel = z.infer<typeof ResultViewModelSchema>;
